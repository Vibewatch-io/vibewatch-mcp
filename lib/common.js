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
 * bridge out). Math.abs: a far-future openedAt (clock skew, clock jump)
 * must also expire rather than suppress until the wall clock catches up.
 */
function readFreshAuthMarker(serverUrl, ttlMs = AUTH_MARKER_TTL_MS) {
  try {
    const raw = fs.readFileSync(authMarkerPath(serverUrl), "utf8");
    const openedAt = JSON.parse(raw).openedAt;
    if (!Number.isFinite(openedAt)) return null;
    if (Math.abs(Date.now() - openedAt) > ttlMs) return null;
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
  TOKENS_GRACE_MS,
  authCacheBase,
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
  writeAuthMarker,
};
