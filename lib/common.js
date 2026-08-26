"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_URL = "https://api.vibewatch.io/mcp/";

// Signatures of a failed authentication in mcp-remote's stderr. Note a
// rejected key does NOT produce any of these — mcp-remote swallows the 401
// and falls into its interactive OAuth flow, so key-mode callers must treat
// AUTH_PROMPT_RE as the rejected-key signal. Word boundaries matter: a bare
// `401` would match the OAuth callback port in mcp-remote's startup line
// (e.g. "running at http://127.0.0.1:3401") and abort a healthy sign-in.
const AUTH_FAILURE_RE =
  /\b401\b|\bUnauthorized\b|Requested scopes are not valid|InvalidClientMetadataError/i;
const AUTH_PROMPT_RE = /Please authorize this client by visiting/;
// Printed when auth is needed, by the lock owner AND by a secondary
// instance waiting on another process's sign-in — the secondary never
// prints the authorize-URL prompt, and its wait can never complete in the
// pinned mcp-remote, so both consumers must bound this state.
const AUTH_WAIT_RE = /Authentication required/;
const PROXY_UP_RE = /Proxy established successfully/;

function fail(message) {
  // Callers rely on fail() never returning (resolveMcpRemoteBin would
  // otherwise hand its caller undefined), and the message must survive a
  // piped stderr — writeSync delivers it before the exit either way.
  try {
    fs.writeSync(process.stderr.fd, `vibewatch-mcp: ${message}\n`);
  } catch {
    /* a broken stderr must not mask the exit */
  }
  process.exit(1);
}

/**
 * Line-buffered scanning over a stream: signatures like AUTH_PROMPT_RE can
 * span two data chunks, so matching per chunk misses them. push() feeds a
 * chunk, flush() delivers any unterminated final line.
 */
function makeLineSplitter(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    flush() {
      if (buffer !== "") {
        onLine(buffer);
        buffer = "";
      }
    },
  };
}

/**
 * End a spawned mcp-remote politely but reliably: its auth coordinator
 * installs a SIGINT handler that cleans up and never exits, so a lone
 * SIGINT can leave the child running forever. Escalate to SIGKILL shortly
 * after. Returns the escalation timer (unref'd).
 */
function killChild(child, escalateMs = 2_000) {
  child.kill("SIGINT");
  const timer = setTimeout(() => child.kill("SIGKILL"), escalateMs);
  timer.unref();
  return timer;
}

/**
 * The argument list handed to mcp-remote, shared by the bridge and the
 * connect-buzz verification spawn. No --auth-timeout: in the pinned
 * mcp-remote it only bounds a secondary-instance long poll, not the actual
 * wait for the authorization callback — callers bound that with their own
 * timer around AUTH_PROMPT_RE instead.
 */
function bridgeArgs({ keyMode, serverUrl, passthrough = [] }) {
  return [
    serverUrl,
    "--transport",
    "http-only",
    ...(keyMode
      ? ["--header", "Authorization: Bearer ${VIBEWATCH_MCP_KEY}"]
      : []),
    ...passthrough,
  ];
}

/** Where mcp-remote keeps its per-server auth cache (and we our marker). */
function authCacheBase() {
  return (
    process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), ".mcp-auth")
  );
}

/** The md5-of-URL hash mcp-remote keys its cache files by. */
function serverHash(serverUrl) {
  return crypto.createHash("md5").update(serverUrl).digest("hex");
}

// "Auth phase underway, not completed" marker (issue #4): a headless host
// that respawns the bridge after every auth timeout would otherwise open a
// fresh browser tab per respawn. Lives at the cache BASE, not inside a
// mcp-remote-<version>/ dir — those belong to mcp-remote, and the version
// constant baked into its build drifts from the package version.
//
// Since issue #10 the marker carries a `kind` and doubles as the machine-wide
// "who opens the sign-in tab" claim (mcp-remote's own auto-open is suppressed
// under the bridge — see lib/no-auto-open.js):
//   - "opened": a bridge actually opened (or owns opening) the tab. Fresh
//     `opened` markers block every other would-be opener.
//   - "wait":   an auth phase is underway but no tab is known-opened — written
//     by a bridge whose mcp-remote is a shared-auth secondary (it only ever
//     prints wait lines, never the authorize URL). Suppresses host respawns
//     like `opened`, but the prompt owner may atomically upgrade it and open.
//   Legacy markers without the field read as "opened" (conservative: they
//   were only ever written when a tab had been opened).
//
// TTL: after 24h an unanswered marker expires and one new prompt is allowed.
// That is deliberate (prescribed by issue #4): while a sign-in stays missing,
// a passive host retry may open at most one tab per server per day — the
// alternative is a permanent lockout that only `connect-buzz` or --reset can
// clear. The window also self-heals a marker orphaned by a crash between
// sign-in completion and the clear on proxy-up.
const AUTH_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

function authMarkerPath(serverUrl) {
  return path.join(
    authCacheBase(),
    `vibewatch-${serverHash(serverUrl)}_pending-auth.json`
  );
}

/**
 * Record that an auth phase is underway. Atomic (tmp + rename) so a crash
 * mid-write can't leave corrupt JSON that reads as "no marker". Throws on
 * failure — the bridge prints a named diagnostic, because a silently
 * unwritable marker means the tab-storm suppression is off.
 *
 * Overwrites whatever marker exists — callers that must not clobber a
 * concurrent claimant's `opened` marker go through recordWaitMarker /
 * tryClaimAuthPrompt instead. (connect-buzz and the tests still use this
 * direct form.)
 */
function writeAuthMarker(serverUrl, kind = "opened") {
  const markerPath = authMarkerPath(serverUrl);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmpPath = `${markerPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({ openedAt: Date.now(), kind }) + "\n"
    );
    fs.renameSync(tmpPath, markerPath);
  } catch (err) {
    // A failed rename (Windows EPERM/EBUSY while the marker is open
    // elsewhere) must not strand tmp files in the cache dir — nothing else
    // ever cleans them up.
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* the write failure is the error worth reporting */
    }
    throw err;
  }
}

/** Best-effort removal — a clear that fails must never break the bridge. */
function clearAuthMarker(serverUrl) {
  try {
    fs.rmSync(authMarkerPath(serverUrl), { force: true });
  } catch {
    /* the TTL is the backstop */
  }
}

/**
 * The unexpired marker for this server, or null. Corrupt or unreadable
 * markers read as absent (fail open — a broken cache dir must not lock the
 * bridge out). Any future openedAt (the clock moved backward since the
 * write) also reads as absent: tolerating it would extend suppression past
 * the TTL, while rejecting it merely allows one prompt, which rewrites the
 * marker at the current clock.
 */
function readFreshAuthMarker(serverUrl, ttlMs = AUTH_MARKER_TTL_MS) {
  try {
    const raw = fs.readFileSync(authMarkerPath(serverUrl), "utf8");
    const parsed = JSON.parse(raw);
    const openedAt = parsed.openedAt;
    if (!Number.isFinite(openedAt)) return null;
    const now = Date.now();
    if (openedAt > now || now - openedAt > ttlMs) return null;
    // Legacy markers (pre-#10, no kind) read as "opened": they were only
    // ever written when a tab had actually been opened.
    return { openedAt, kind: parsed.kind === "wait" ? "wait" : "opened" };
  } catch {
    return null;
  }
}

// Grace subtracted from the marker's openedAt when comparing token mtimes.
// Two reachable orderings leave a valid, just-completed sign-in slightly
// OLDER than a marker: a bridge that lost the sign-in lockfile race writes
// its marker (shared-auth wait line) moments after the winner's tokens
// landed, and coarse-mtime filesystems (FAT, some network mounts) truncate
// a token write to below openedAt. Without the grace, both would suppress a
// correctly signed-in user for the full TTL. 60s is far below any plausible
// gap between a genuinely stale token file and a new prompt.
const TOKENS_GRACE_MS = 60_000;

/**
 * True if any mcp-remote version dir holds a tokens file for this server
 * written AFTER sinceMs. Mere token existence must not count — a stale,
 * revoked, or old-version tokens file would bypass a fresh marker and
 * re-enable the tab storm. Newer-than-the-marker means the sign-in completed
 * after the prompt opened (e.g. via connect-buzz or another process's tab).
 */
function newerTokensExist(serverUrl, sinceMs) {
  const hash = serverHash(serverUrl);
  const base = authCacheBase();
  let versionDirs;
  try {
    versionDirs = fs
      .readdirSync(base)
      .filter((d) => d.startsWith("mcp-remote-"));
  } catch {
    return false;
  }
  for (const versionDir of versionDirs) {
    try {
      const stat = fs.statSync(
        path.join(base, versionDir, `${hash}_tokens.json`)
      );
      if (stat.mtimeMs > sinceMs) return true;
    } catch {
      /* no tokens in this version dir */
    }
  }
  return false;
}

/**
 * Should an OAuth-mode bridge spawn mcp-remote (which may open a browser
 * tab)? Returns:
 *   "clear"     — no live marker; a prompt is allowed.
 *   "satisfied" — marker present but a newer sign-in landed; clear the
 *                 marker and proceed.
 *   "suppress"  — a prompt was already opened and never completed; do not
 *                 spawn (no new tab), point at connect-buzz instead.
 */
function oauthSpawnGate(serverUrl, ttlMs = AUTH_MARKER_TTL_MS) {
  const marker = readFreshAuthMarker(serverUrl, ttlMs);
  if (!marker) return "clear";
  if (newerTokensExist(serverUrl, marker.openedAt - TOKENS_GRACE_MS)) {
    return "satisfied";
  }
  return "suppress";
}

// ---------------------------------------------------------------------------
// Bridge-owned browser opening (issue #10): mcp-remote's own auto-open is
// suppressed under the bridge (lib/no-auto-open.js), the bridge extracts the
// authorize URL from mcp-remote's prompt output and opens it itself — at most
// once machine-wide per auth phase, decided by an atomic claim on the
// pending-auth marker.
// ---------------------------------------------------------------------------

/** Absolute path of the --require preload handed to the mcp-remote spawn. */
function noAutoOpenShimPath() {
  return path.join(__dirname, "no-auto-open.js");
}

const URL_IN_LINE_RE = /https?:\/\/[^\s"'<>]+/;

/**
 * The first http(s) URL in a line of mcp-remote output, or null. The real
 * mcp-remote prints "Please authorize this client by visiting:" with the URL
 * on the following line; validate rather than trust the stream shape.
 */
function extractAuthUrl(line) {
  const match = URL_IN_LINE_RE.exec(line);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Shared steal/verify/restore primitive for the file protocols here (the
 * auth marker and the spawn claim — the review flagged the duplicated
 * atomicity reasoning as a drift hazard): rename the live path to a unique
 * name (exactly one renamer wins), verify the STOLEN content really is
 * retire-able — it may have changed between the caller's read and the
 * rename — and restore a live file this turns out to have stolen, but only
 * if the path is still free: rename overwrites its destination, and a third
 * process may have re-acquired the path in the steal window (existsSync →
 * rename is itself the documented residual triple-race; it degrades to one
 * extra concurrent owner). Never a read-then-rm: two readers of one stale
 * file could otherwise both "retire" it, the second rm-ing the first's
 * fresh acquisition.
 *
 * Returns true when the path is now free for the caller to acquire.
 */
function atomicRetirePath(livePath, uniqueSuffix, read, retireable) {
  const stolenPath = `${livePath}.${uniqueSuffix}`;
  try {
    fs.renameSync(livePath, stolenPath);
  } catch {
    return false; // someone else renamed (or cleared) it first
  }
  if (!retireable(read(stolenPath))) {
    try {
      if (!fs.existsSync(livePath)) {
        fs.renameSync(stolenPath, livePath);
        return false;
      }
    } catch {
      /* fall through to dropping the stolen file */
    }
    try {
      fs.rmSync(stolenPath, { force: true });
    } catch {
      /* uniquely named; harmless — its owner notices at its next check */
    }
    return false;
  }
  try {
    fs.rmSync(stolenPath, { force: true });
  } catch {
    /* uniquely named; harmless */
  }
  return true;
}

function readMarkerFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Number.isFinite(parsed.openedAt)) return null;
    return {
      openedAt: parsed.openedAt,
      kind: parsed.kind === "wait" ? "wait" : "opened",
    };
  } catch {
    return null;
  }
}

/**
 * Atomically retire the current marker so the path is free to wx-acquire.
 * Retire-able: corrupt, expired, satisfied (newer tokens landed), or kind
 * "wait" (no tab behind it). A stolen fresh unsatisfied `opened` marker is
 * restored — that is why the bridge uses this instead of clearAuthMarker on
 * its satisfied/proxy-up paths: a blind clear there could erase a NEWER
 * auth phase's live claim and let a second tab open (review P1).
 * Returns true when the path is now free for this process to claim.
 */
function tryRetireAuthMarker(serverUrl, ttlMs = AUTH_MARKER_TTL_MS) {
  return atomicRetirePath(
    authMarkerPath(serverUrl),
    `retire-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
    readMarkerFile,
    (stolen) => {
      if (!stolen) return true;
      const now = Date.now();
      const fresh = stolen.openedAt <= now && now - stolen.openedAt <= ttlMs;
      if (!fresh) return true;
      if (newerTokensExist(serverUrl, stolen.openedAt - TOKENS_GRACE_MS)) {
        return true;
      }
      return stolen.kind === "wait";
    }
  );
}

/**
 * After a failed browser opener: the `opened` marker this process just
 * claimed would otherwise suppress every session for the full TTL with NO
 * tab behind it (review P2). Demoting it to `wait` keeps host respawns
 * suppressed but lets another session's prompt claim and try ITS opener.
 * Best-effort blind overwrite — this process wrote the fresh `opened`
 * marker moments ago, so clobbering a third party needs the same µs-class
 * window as the protocol's other documented residual races.
 */
function demoteAuthMarkerToWait(serverUrl) {
  try {
    writeAuthMarker(serverUrl, "wait");
  } catch {
    /* the TTL is the backstop */
  }
}

/**
 * Decide, machine-wide, whether THIS process opens the sign-in tab for the
 * current auth phase. Returns:
 *   {claimed:true}                 — we own the marker; open the tab.
 *   {claimed:true, degraded}      — marker storage is unusable; open anyway
 *     (fail-open, matching the marker's existing policy: a broken cache dir
 *     must not lock sign-in out) and surface the named reason.
 *   {claimed:false}               — a fresh `opened` marker stands: another
 *     session's tab is already up; do not open.
 */
function tryClaimAuthPrompt(serverUrl, ttlMs = AUTH_MARKER_TTL_MS) {
  const markerPath = authMarkerPath(serverUrl);
  // Several rounds of wx → (blocked? / retire): with mcp-remote's auto-open
  // suppressed, a wrong `claimed:false` here means ZERO tabs for the phase
  // (review P2 — a sibling's recordWaitMarker can win the path in the
  // retire→create gap, and two rounds gave up on exactly that interleaving).
  // Only a fresh unsatisfied `opened` marker — someone's tab really is up —
  // may yield.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(
        markerPath,
        JSON.stringify({ openedAt: Date.now(), kind: "opened" }) + "\n",
        { flag: "wx" }
      );
      return { claimed: true };
    } catch (err) {
      if (err.code !== "EEXIST") {
        return { claimed: true, degraded: err.message };
      }
    }
    const marker = readFreshAuthMarker(serverUrl, ttlMs);
    if (
      marker &&
      marker.kind === "opened" &&
      !newerTokensExist(serverUrl, marker.openedAt - TOKENS_GRACE_MS)
    ) {
      return { claimed: false };
    }
    // Expired, satisfied, corrupt, or a tab-less `wait` marker — retire it
    // and retry the exclusive create.
    tryRetireAuthMarker(serverUrl, ttlMs);
  }
  // Still contended after the rounds. If a live tab now stands, yield;
  // otherwise fail OPEN with an atomic overwrite — the residual cost is one
  // extra tab (the pre-#10 economics), which beats a phase where nobody
  // opens and every session hangs to its auth timeout.
  const marker = readFreshAuthMarker(serverUrl, ttlMs);
  if (
    marker &&
    marker.kind === "opened" &&
    !newerTokensExist(serverUrl, marker.openedAt - TOKENS_GRACE_MS)
  ) {
    return { claimed: false };
  }
  try {
    writeAuthMarker(serverUrl, "opened");
    return { claimed: true };
  } catch (err) {
    return { claimed: true, degraded: err.message };
  }
}

/**
 * Record that an auth phase is underway WITHOUT claiming the tab (the
 * shared-auth wait path: this bridge's mcp-remote is a secondary and never
 * prints the authorize URL). Exclusive create only — it must never clobber
 * a concurrent claimant's `opened` marker (that would let a third session
 * open a second tab). An existing fresh marker of either kind already does
 * this marker's job; a stale one is retired first. Throws like
 * writeAuthMarker on unusable storage.
 */
function recordWaitMarker(serverUrl, ttlMs = AUTH_MARKER_TTL_MS) {
  const markerPath = authMarkerPath(serverUrl);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(
        markerPath,
        JSON.stringify({ openedAt: Date.now(), kind: "wait" }) + "\n",
        { flag: "wx" }
      );
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    if (readFreshAuthMarker(serverUrl, ttlMs)) return; // already covered
    if (!tryRetireAuthMarker(serverUrl, ttlMs)) return;
  }
  // Contended past both rounds: give up silently. Unlike tryClaimAuthPrompt
  // this must NOT fail open with an overwrite — the marker here is only
  // respawn suppression, and clobbering a claimant's fresh `opened` marker
  // would let a third session open a second tab. Worst case of recording
  // nothing: one extra prompt on a later host respawn.
}

/**
 * Open a URL in the user's browser. Resolves true once the opener child
 * spawns, false on spawn failure — reported via the child's async `error`
 * event, not a throw (the plan-review P2), so callers can print
 * copy-the-URL guidance. VIBEWATCH_MCP_OPEN_CMD overrides the platform
 * opener (invoked with the URL as its single argument) — test seam and
 * escape hatch for odd hosts. win32 uses rundll32, not `cmd /c start`:
 * authorize URLs carry `&`-separated query params, which cmd would split.
 */
function openBrowser(
  url,
  { env = process.env, platform = process.platform } = {}
) {
  return new Promise((resolve) => {
    let command;
    let args;
    if (env.VIBEWATCH_MCP_OPEN_CMD) {
      command = env.VIBEWATCH_MCP_OPEN_CMD;
      args = [url];
    } else if (platform === "darwin") {
      command = "open";
      args = [url];
    } else if (platform === "win32") {
      command = "rundll32";
      args = ["url.dll,FileProtocolHandler", url];
    } else {
      command = "xdg-open";
      args = [url];
    }
    let child;
    try {
      child = spawn(command, args, { stdio: "ignore", detached: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.once("error", () => settle(false));
    child.once("spawn", () => {
      child.unref();
      settle(true);
    });
  });
}

// ---------------------------------------------------------------------------
// Spawn claim (issue #6): on Windows the bundled mcp-remote SKIPS its own
// sign-in lockfile, so N concurrently launched OAuth bridges would each open
// an authorize tab. A claim file at the cache base makes spawning the OAuth
// path single-owner there; POSIX keeps relying on mcp-remote's lockfile.
//
// Ownership protocol (file-based; Node has no portable OS mutex without
// native deps):
//   - acquire: exclusive create (wx) of {ownerId, claimedAt, renewedAt}.
//   - liveness: the owner rewrites renewedAt every CLAIM_RENEW_MS; staleness
//     is renewal age, never total age, so a slow pre-auth phase can't get a
//     live owner evicted (adversarial-review medium).
//   - takeover of a stale claim: atomic rename to a unique name (exactly one
//     renamer wins), then VERIFY the renamed content really is stale — if the
//     file changed between the stale read and the rename (a live owner's
//     fresh claim was stolen), rename it back. Plain rm+recreate would let
//     two readers of one stale claim both "take over" (adversarial-review
//     high).
//   - release: only after re-reading that the file still carries our
//     ownerId, so an old owner can never delete a newer generation's claim.
// Residual races (read→rm in release, restore-vs-create in takeover) need a
// third process inside a millisecond window and degrade to one extra
// concurrent owner — accepted for a file protocol.
// ---------------------------------------------------------------------------

// Moved here from the bin so CLAIM_WAIT_MS can derive from it in one module:
// how long the bridge waits for a browser sign-in after mcp-remote prints
// the authorization prompt (mcp-remote itself never times that wait out).
const BRIDGE_AUTH_WAIT_MS = 180_000;
const CLAIM_RENEW_MS = 10_000;
const CLAIM_STALE_MS = 45_000;
// How long a claim-owning bridge may sit with NEITHER an auth line NOR a
// connected proxy before it gives up its child and exits (releasing the
// claim) so the next session can try. Releasing while the stalled child
// kept running was rejected in review: accumulated bridges would all
// prompt at once when the server recovered — the exact multi-tab storm the
// claim exists to prevent. Sized to BRIDGE_AUTH_WAIT_MS, NOT shorter: the
// abort fires with no contention check, so this is also the hard connect
// deadline a SOLO Windows session gets (cold cache under a virus scanner,
// corporate proxy) — a working-but-slow environment must fit inside it.
const CLAIM_PREAUTH_ABORT_MS = BRIDGE_AUTH_WAIT_MS;
// A secondary waits out the owner's whole possible lifetime: the pre-auth
// phase (bounded by the abort above) PLUS the auth wait, plus slack — a
// 90s discovery followed by a 170s approval is a healthy owner, and a
// waiter must not give up in the middle of it.
const CLAIM_WAIT_MS = CLAIM_PREAUTH_ABORT_MS + BRIDGE_AUTH_WAIT_MS + 60_000;
const CLAIM_POLL_MS = 2_000;

/** The claim only guards platforms where mcp-remote provides no lock. */
function spawnClaimEnabled(platform = process.platform) {
  return platform === "win32";
}

function claimPath(serverUrl) {
  return path.join(
    authCacheBase(),
    `vibewatch-${serverHash(serverUrl)}_spawn-claim.json`
  );
}

function newOwnerId() {
  return `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
}

function readClaimFile(filePath) {
  try {
    const claim = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof claim.ownerId !== "string") return null;
    if (!Number.isFinite(claim.renewedAt)) return null;
    return claim;
  } catch {
    return null;
  }
}

/** Corrupt or clock-skewed (far-future) claims count as stale. */
function claimIsStale(claim, now = Date.now()) {
  if (!claim) return true;
  return Math.abs(now - claim.renewedAt) > CLAIM_STALE_MS;
}

function writeClaimFile(filePath, claim, { exclusive }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (exclusive) {
    fs.writeFileSync(filePath, JSON.stringify(claim) + "\n", { flag: "wx" });
    return;
  }
  // Renewal path: atomic replace so a reader never sees a partial write.
  // Ownership is re-read immediately before the rename: an owner suspended
  // mid-callback (SIGSTOP, machine sleep) past staleness can otherwise
  // resume and rename over a successor's claim, since rename replaces its
  // destination. The re-read shrinks that to the same µs-class window as
  // the protocol's other documented residual races.
  const tmpPath = `${filePath}.tmp-${claim.ownerId}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(claim) + "\n");
    const live = readClaimFile(filePath);
    if (!live || live.ownerId !== claim.ownerId) {
      const err = new Error("claim ownership changed");
      err.code = "VW_CLAIM_LOST";
      throw err;
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* the original error is the one to surface */
    }
    throw err;
  }
}

/**
 * Try to atomically retire a stale claim. Returns true when this process
 * retired it (the path is now free to wx-acquire), false when another
 * process got there first or the claim turned out to be live (a stolen
 * live claim is restored — see atomicRetirePath; a dropped one's owner
 * notices the ownership change at its next renewal and stops renewing).
 */
function tryTakeoverClaim(serverUrl, ownerId) {
  return atomicRetirePath(
    claimPath(serverUrl),
    `takeover-${ownerId}`,
    readClaimFile,
    claimIsStale
  );
}

/**
 * Acquire the spawn claim for serverUrl, waiting out a live owner.
 *
 * Returns one of:
 *   {status:"acquired", release, lostOwnership} — this process owns the
 *     claim; renewal runs on an unref'd timer until release() (idempotent).
 *   {status:"suppress"}  — the pending-auth marker appeared while waiting
 *     (the owner prompted and gave up); callers in gateMode "bridge" exit.
 *   {status:"satisfied"} — a sign-in landed while waiting; caller clears
 *     the marker and proceeds unclaimed.
 *   {status:"timeout"}   — a live owner held the claim for the whole wait.
 *   {status:"unclaimed", reason} — claim storage is unusable (not EEXIST);
 *     callers proceed unclaimed with a diagnostic, matching the marker's
 *     fail-open policy (an unwritable cache base breaks mcp-remote's own
 *     token persistence anyway).
 */
async function acquireSpawnSlot(serverUrl, opts = {}) {
  const {
    waitMs = CLAIM_WAIT_MS,
    pollMs = CLAIM_POLL_MS,
    renewMs = CLAIM_RENEW_MS,
    // Called (once) if ownership is lost after acquisition — a suspended
    // owner whose claim went stale and was taken over. The bridge uses it
    // to kill its child: left running, that child could reach the auth
    // phase beside the successor and open a second tab.
    onLost = null,
    // "bridge": react to the pending-auth marker while waiting. "ignore":
    // connect-buzz — the explicit recovery action must not be blocked by
    // the marker it exists to clear.
    gateMode = "bridge",
  } = opts;
  const ownerId = newOwnerId();
  const filePath = claimPath(serverUrl);
  const deadline = Date.now() + waitMs;

  // Create the directory up front, OUTSIDE the loop's EEXIST handling: a
  // FILE squatting on the cache-base path makes mkdir throw EEXIST too,
  // which must read as unusable storage, never as "claim held".
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (err) {
    return { status: "unclaimed", reason: err.message };
  }

  for (;;) {
    // Only the exclusive create sits in the try: a throw from the
    // post-acquisition work below would hit a catch that returns
    // "unclaimed" while a live, renewing claim stays on disk, blocking
    // every sibling for the whole wait.
    let acquired = false;
    try {
      const now = Date.now();
      writeClaimFile(filePath, { ownerId, claimedAt: now, renewedAt: now }, {
        exclusive: true,
      });
      acquired = true;
    } catch (err) {
      if (err.code !== "EEXIST") {
        return { status: "unclaimed", reason: err.message };
      }
    }
    if (acquired) {
      const handle = makeClaimHandle(serverUrl, filePath, ownerId, renewMs, onLost);
      if (gateMode === "bridge") {
        // Re-check the marker AFTER winning the claim: the previous owner
        // may have prompted, failed, and released while we waited — the
        // pre-claim gate the caller ran can't have seen that.
        const gate = oauthSpawnGate(serverUrl);
        if (gate === "suppress") {
          handle.release();
          return { status: "suppress" };
        }
        if (gate === "satisfied") clearAuthMarker(serverUrl);
      }
      return handle;
    }

    // Someone holds the claim. React to state changes while we wait.
    const holderIsLive = !claimIsStale(readClaimFile(filePath));
    if (gateMode === "bridge") {
      const gate = oauthSpawnGate(serverUrl);
      if (gate === "satisfied") return { status: "satisfied" };
      // A marker while the owner is LIVE just means the owner's sign-in
      // tab is open — keep waiting for it to complete (the Codex P1: an
      // immediate suppress here made every concurrent session fail during
      // a sign-in instead of waiting it out). Suppress only once the
      // owner is gone and the prompt still went unanswered.
      if (gate === "suppress" && !holderIsLive) return { status: "suppress" };
    }
    if (!holderIsLive) {
      tryTakeoverClaim(serverUrl, ownerId);
      // No `continue` past the checks below: a claim that keeps reading
      // stale but can't be retired (EPERM on rename) must still hit the
      // deadline and the sleep, not spin hot forever.
    }
    if (Date.now() >= deadline) return { status: "timeout" };
    // Deliberately NOT unref'd: this sleep is what keeps a waiting bridge
    // alive (nothing else is on the event loop pre-spawn), and the loop is
    // bounded by the deadline above.
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function makeClaimHandle(
  serverUrl,
  filePath,
  ownerId,
  renewMs = CLAIM_RENEW_MS,
  onLost = null
) {
  let lost = false;
  let released = false;
  const markLost = () => {
    lost = true;
    clearInterval(renewTimer);
    if (onLost) {
      const cb = onLost;
      onLost = null; // fire once
      try {
        cb();
      } catch {
        /* the caller's teardown must not break the renewal path */
      }
    }
  };
  const renewTimer = setInterval(() => {
    const current = readClaimFile(filePath);
    if (!current || current.ownerId !== ownerId) {
      // Taken over (or cleared) — stop renewing; never overwrite the new
      // generation.
      markLost();
      return;
    }
    try {
      writeClaimFile(
        filePath,
        { ...current, renewedAt: Date.now() },
        { exclusive: false }
      );
    } catch (err) {
      if (err.code === "VW_CLAIM_LOST") {
        // Ownership changed between our read and the rename — disarm, as
        // in the read-based takeover detection above.
        markLost();
        return;
      }
      /* any other missed renewal only ages the claim toward staleness */
    }
  }, renewMs);
  if (typeof renewTimer.unref === "function") renewTimer.unref();
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(renewTimer);
    const current = readClaimFile(filePath);
    if (!lost && current && current.ownerId === ownerId) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* staleness reclaims it */
      }
    }
  };
  return { status: "acquired", release, lostOwnership: () => lost };
}

/**
 * Resolve the bundled mcp-remote entry script. The dependency is pinned to an
 * exact version because mcp-remote keys its token cache directory by its own
 * version — a silent range bump would orphan cached sign-ins.
 *
 * Throws rather than exiting: the bridge wants fail-fast, but the connect
 * flow needs a clean rejection so its buffered progress output survives.
 */
function resolveMcpRemoteBin() {
  try {
    const pkgJsonPath = require.resolve("mcp-remote/package.json");
    const pkg = require(pkgJsonPath);
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["mcp-remote"];
    return path.join(path.dirname(pkgJsonPath), rel);
  } catch (err) {
    throw new Error(
      `could not resolve the bundled mcp-remote dependency (${err.message}). ` +
        "Reinstall with: npm install -g vibewatch-mcp"
    );
  }
}

module.exports = {
  DEFAULT_URL,
  AUTH_FAILURE_RE,
  AUTH_PROMPT_RE,
  AUTH_WAIT_RE,
  PROXY_UP_RE,
  AUTH_MARKER_TTL_MS,
  BRIDGE_AUTH_WAIT_MS,
  CLAIM_PREAUTH_ABORT_MS,
  CLAIM_RENEW_MS,
  CLAIM_STALE_MS,
  CLAIM_WAIT_MS,
  TOKENS_GRACE_MS,
  acquireSpawnSlot,
  authCacheBase,
  claimIsStale,
  claimPath,
  readClaimFile,
  authMarkerPath,
  bridgeArgs,
  clearAuthMarker,
  demoteAuthMarkerToWait,
  extractAuthUrl,
  fail,
  makeLineSplitter,
  killChild,
  newerTokensExist,
  noAutoOpenShimPath,
  oauthSpawnGate,
  openBrowser,
  readFreshAuthMarker,
  recordWaitMarker,
  resolveMcpRemoteBin,
  serverHash,
  spawnClaimEnabled,
  tryClaimAuthPrompt,
  tryRetireAuthMarker,
  tryTakeoverClaim,
  writeAuthMarker,
};
