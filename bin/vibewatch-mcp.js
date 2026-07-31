#!/usr/bin/env node
"use strict";

/**
 * vibewatch-mcp — stdio bridge to the Vibewatch MCP server.
 *
 * Wraps mcp-remote so any stdio MCP client (Buzz agents, Claude Code, Goose,
 * Codex) can reach https://api.vibewatch.io/mcp/ with a Vibewatch MCP key.
 *
 * Required env:  VIBEWATCH_MCP_KEY  — an org-scoped key (starts with vw_mcp_),
 *                minted in app.vibewatch.io → Settings → API Access.
 * Optional env:  VIBEWATCH_MCP_URL  — override the server URL (self-hosted /
 *                staging).
 *
 * The key is passed to mcp-remote as the literal string
 * "Authorization: Bearer ${VIBEWATCH_MCP_KEY}" — mcp-remote expands the env
 * var itself, so the key never appears in the process argument list.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");

const DEFAULT_URL = "https://api.vibewatch.io/mcp/";

function fail(message) {
  process.stderr.write(`vibewatch-mcp: ${message}\n`);
  process.exit(1);
}

if (!process.env.VIBEWATCH_MCP_KEY) {
  fail(
    [
      "VIBEWATCH_MCP_KEY is not set.",
      "",
      "Mint a key in app.vibewatch.io → Settings → API Access (keys start with vw_mcp_),",
      "then set it in the environment:",
      "",
      "  export VIBEWATCH_MCP_KEY=vw_mcp_...",
      "",
      "MCP access is opt-in per organization — an owner or admin can enable it in the",
      "same Settings → API Access section.",
    ].join("\n")
  );
}

const serverUrl = process.env.VIBEWATCH_MCP_URL || DEFAULT_URL;

let mcpRemoteBin;
try {
  const pkgJsonPath = require.resolve("mcp-remote/package.json");
  const pkg = require(pkgJsonPath);
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["mcp-remote"];
  mcpRemoteBin = path.join(path.dirname(pkgJsonPath), rel);
} catch (err) {
  fail(
    `could not resolve the bundled mcp-remote dependency (${err.message}). ` +
      "Reinstall with: npm install -g vibewatch-mcp"
  );
}

// Extra args (e.g. --debug) pass straight through to mcp-remote.
// --auth-timeout bounds the OAuth fallback that engages on a rejected key, so
// headless hosts (Buzz agent sandboxes) fail fast instead of waiting on a
// browser that will never open. User-supplied flags come later and win.
const passthrough = process.argv.slice(2);

const child = spawn(
  process.execPath,
  [
    mcpRemoteBin,
    serverUrl,
    "--transport",
    "http-only",
    "--header",
    "Authorization: Bearer ${VIBEWATCH_MCP_KEY}",
    "--auth-timeout",
    "30",
    ...passthrough,
  ],
  { stdio: ["inherit", "inherit", "pipe"] }
);

// Forward stderr while watching for the signatures of a rejected key. A bad
// key surfaces as a 401 that drops mcp-remote into an OAuth fallback our
// key-based server never completes — translate that into the real fix.
let sawAuthFailure = false;
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  const text = chunk.toString();
  if (
    /401|Unauthorized|Requested scopes are not valid|InvalidClientMetadataError/i.test(
      text
    )
  ) {
    sawAuthFailure = true;
  }
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (code !== 0 && sawAuthFailure) {
    process.stderr.write(
      "\nvibewatch-mcp: the server rejected this VIBEWATCH_MCP_KEY. " +
        "Check the key (it should start with vw_mcp_), or mint a new one in " +
        "app.vibewatch.io → Settings → API Access.\n"
    );
  }
  process.exit(code === null ? 1 : code);
});

child.on("error", (err) => {
  fail(`failed to start mcp-remote: ${err.message}`);
});
