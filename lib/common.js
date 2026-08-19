"use strict";

const fs = require("node:fs");
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
  PROXY_UP_RE,
  bridgeArgs,
  fail,
  makeLineSplitter,
  killChild,
  resolveMcpRemoteBin,
};
