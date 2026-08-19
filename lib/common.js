"use strict";

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
  process.stderr.write(`vibewatch-mcp: ${message}\n`);
  process.exit(1);
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
 */
function resolveMcpRemoteBin() {
  try {
    const pkgJsonPath = require.resolve("mcp-remote/package.json");
    const pkg = require(pkgJsonPath);
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["mcp-remote"];
    return path.join(path.dirname(pkgJsonPath), rel);
  } catch (err) {
    fail(
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
  resolveMcpRemoteBin,
};
