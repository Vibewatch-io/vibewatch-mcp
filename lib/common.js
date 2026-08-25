"use strict";

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

// "Authorize prompt opened, not completed" marker (issue #4): a headless host
// that respawns the bridge after every auth timeout would otherwise open a
// fresh browser tab per respawn. Lives at the cache BASE, not inside a
// mcp-remote-<version>/ dir — those belong to mcp-remote, and the version
// constant baked into its build drifts from the package version.
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
 * Record that an authorize prompt was opened. Atomic (tmp + rename) so a
 * crash mid-write can't leave corrupt JSON that reads as "no marker". Throws
 * on failure — the bridge prints a named diagnostic, because a silently
 * unwritable marker means the tab-storm suppression is off.
 */
function writeAuthMarker(serverUrl) {
  const markerPath = authMarkerPath(serverUrl);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmpPath = `${markerPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ openedAt: Date.now() }) + "\n");
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
    const openedAt = JSON.parse(raw).openedAt;
    if (!Number.isFinite(openedAt)) return null;
    const now = Date.now();
    if (openedAt > now || now - openedAt > ttlMs) return null;
    return { openedAt };
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
// A secondary waits out the owner's whole possible auth phase plus slack.
const CLAIM_WAIT_MS = BRIDGE_AUTH_WAIT_MS + 60_000;
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
  const tmpPath = `${filePath}.tmp-${claim.ownerId}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(claim) + "\n");
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
 * process got there first or the claim turned out to be live.
 */
function tryTakeoverClaim(serverUrl, ownerId) {
  const livePath = claimPath(serverUrl);
  const stolenPath = `${livePath}.takeover-${ownerId}`;
  try {
    fs.renameSync(livePath, stolenPath);
  } catch {
    return false; // someone else renamed (or released) it first
  }
  const stolen = readClaimFile(stolenPath);
  if (claimIsStale(stolen)) {
    try {
      fs.rmSync(stolenPath, { force: true });
    } catch {
      /* orphaned takeover file; harmless, uniquely named */
    }
    return true;
  }
  // The file changed between our stale read and the rename — we stole a
  // LIVE claim. Put it back; if a third process already created a new claim
  // in the window, drop the stolen one instead (its owner will notice the
  // ownership change at its next renewal and stop renewing).
  try {
    fs.renameSync(stolenPath, livePath);
  } catch {
    try {
      fs.rmSync(stolenPath, { force: true });
    } catch {
      /* orphaned takeover file; harmless */
    }
  }
  return false;
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
    try {
      const now = Date.now();
      writeClaimFile(filePath, { ownerId, claimedAt: now, renewedAt: now }, {
        exclusive: true,
      });
      return makeClaimHandle(serverUrl, filePath, ownerId);
    } catch (err) {
      if (err.code !== "EEXIST") {
        return { status: "unclaimed", reason: err.message };
      }
    }

    // Someone holds the claim. React to state changes while we wait.
    if (gateMode === "bridge") {
      const gate = oauthSpawnGate(serverUrl);
      if (gate === "suppress") return { status: "suppress" };
      if (gate === "satisfied") return { status: "satisfied" };
    }
    if (claimIsStale(readClaimFile(filePath))) {
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

function makeClaimHandle(serverUrl, filePath, ownerId) {
  let lost = false;
  let released = false;
  const renewTimer = setInterval(() => {
    const current = readClaimFile(filePath);
    if (!current || current.ownerId !== ownerId) {
      // Taken over (or cleared) — stop renewing; never overwrite the new
      // generation. The session keeps running, merely unclaimed.
      lost = true;
      clearInterval(renewTimer);
      return;
    }
    try {
      writeClaimFile(
        filePath,
        { ...current, renewedAt: Date.now() },
        { exclusive: false }
      );
    } catch {
      /* a missed renewal only ages the claim toward staleness */
    }
  }, CLAIM_RENEW_MS);
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
  CLAIM_RENEW_MS,
  CLAIM_STALE_MS,
  CLAIM_WAIT_MS,
  TOKENS_GRACE_MS,
  acquireSpawnSlot,
  authCacheBase,
  claimIsStale,
  claimPath,
  authMarkerPath,
  bridgeArgs,
  clearAuthMarker,
  fail,
  makeLineSplitter,
  killChild,
  newerTokensExist,
  oauthSpawnGate,
  readFreshAuthMarker,
  resolveMcpRemoteBin,
  serverHash,
  spawnClaimEnabled,
  tryTakeoverClaim,
  writeAuthMarker,
};
