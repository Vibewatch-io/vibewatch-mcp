#!/usr/bin/env node
"use strict";

/**
 * vibewatch-mcp — stdio bridge to the Vibewatch MCP server.
 *
 * Wraps mcp-remote so any stdio MCP client (Buzz agents, Claude Code, Goose,
 * Codex) can reach https://api.vibewatch.io/mcp/.
 *
 * Two ways to authenticate:
 *   - OAuth (default): run `vibewatch-mcp connect-buzz` once — it signs you in
 *     via the browser and caches tokens that the bridge reuses headlessly.
 *   - Key: set VIBEWATCH_MCP_KEY to an org-scoped key (starts with vw_mcp_),
 *     minted in app.vibewatch.io → Settings → API Access.
 *
 * Optional env:  VIBEWATCH_MCP_URL  — override the server URL (self-hosted /
 *                staging).
 *
 * The key is passed to mcp-remote as the literal string
 * "Authorization: Bearer ${VIBEWATCH_MCP_KEY}" — mcp-remote expands the env
 * var itself, so the key never appears in the process argument list.
 */

const { spawn } = require("node:child_process");

const { DEFAULT_URL, resolveMcpRemoteBin, fail } = require("../lib/common.js");

function runBridge() {
  const keyMode = Boolean(process.env.VIBEWATCH_MCP_KEY);
  const serverUrl = process.env.VIBEWATCH_MCP_URL || DEFAULT_URL;
  const mcpRemoteBin = resolveMcpRemoteBin();

  // Extra args (e.g. --debug) pass straight through to mcp-remote.
  // --auth-timeout bounds the OAuth wait: with cached tokens (seeded by
  // `connect-buzz`) no prompt ever appears; without them, headless hosts (Buzz
  // agent sandboxes, CI) fail fast instead of waiting on a browser that will
  // never open. User-supplied flags come later and win.
  const passthrough = process.argv.slice(2);

  const child = spawn(
    process.execPath,
    [
      mcpRemoteBin,
      serverUrl,
      "--transport",
      "http-only",
      ...(keyMode
        ? ["--header", "Authorization: Bearer ${VIBEWATCH_MCP_KEY}"]
        : []),
      "--auth-timeout",
      "30",
      ...passthrough,
    ],
    { stdio: ["inherit", "inherit", "pipe"] }
  );

  // Forward stderr while watching for the signatures of failed
  // authentication, so the exit message can name the actual fix.
  let sawAuthFailure = false;
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    const text = chunk.toString();
    if (
      /401|Unauthorized|Requested scopes are not valid|InvalidClientMetadataError|Authentication timed out/i.test(
        text
      )
    ) {
      sawAuthFailure = true;
    }
    // A rejected key surfaces as a silent 401 that drops mcp-remote into its
    // interactive OAuth fallback — never right for a key user. Bail out
    // instead of hanging on a browser prompt until the auth timeout.
    if (keyMode && /Please authorize this client by visiting/.test(text)) {
      sawAuthFailure = true;
      child.kill("SIGINT");
    }
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal && !sawAuthFailure) {
      process.kill(process.pid, signal);
      return;
    }
    if ((code !== 0 || signal) && sawAuthFailure) {
      process.stderr.write(
        keyMode
          ? "\nvibewatch-mcp: the server rejected this VIBEWATCH_MCP_KEY. " +
              "Check the key (it should start with vw_mcp_), or mint a new " +
              "one in app.vibewatch.io → Settings → API Access.\n"
          : "\nvibewatch-mcp: not signed in (or the sign-in expired). " +
              "Run `vibewatch-mcp connect-buzz` to sign in via the browser, " +
              "or set VIBEWATCH_MCP_KEY to an org key from " +
              "app.vibewatch.io → Settings → API Access.\n"
      );
    }
    process.exit(code === null ? 1 : code);
  });

  child.on("error", (err) => {
    fail(`failed to start mcp-remote: ${err.message}`);
  });
}

const subcommand = process.argv[2];
if (subcommand === "connect-buzz" || subcommand === "connect") {
  require("../lib/connect.js")
    .run(process.argv.slice(3))
    .then((code) => process.exit(code))
    .catch((err) => fail(err.message));
} else {
  runBridge();
}
