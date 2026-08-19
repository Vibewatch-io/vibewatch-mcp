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
 * The bridge never puts the key on a process argument list — mcp-remote gets
 * the literal string "Authorization: Bearer ${VIBEWATCH_MCP_KEY}" and expands
 * the env var itself. (`connect-buzz --key` is different: the harness CLIs it
 * drives only accept env values as arguments, so the key is briefly visible
 * in their argv — documented in the README.)
 */

const { spawn } = require("node:child_process");

const {
  DEFAULT_URL,
  AUTH_FAILURE_RE,
  AUTH_PROMPT_RE,
  PROXY_UP_RE,
  bridgeArgs,
  makeLineSplitter,
  resolveMcpRemoteBin,
  fail,
} = require("../lib/common.js");

// How long the bridge waits for a browser sign-in after mcp-remote prints the
// authorization prompt. mcp-remote itself never times this wait out (its
// --auth-timeout only bounds a secondary-instance long poll), so without this
// timer a headless host with no cached sign-in would hang forever. Long
// enough for a human to approve on an interactive first connect.
const BRIDGE_AUTH_WAIT_MS = 180_000;

function writeAuthGuidance(keyMode) {
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

function runBridge() {
  const keyMode = Boolean(process.env.VIBEWATCH_MCP_KEY);
  const serverUrl = process.env.VIBEWATCH_MCP_URL || DEFAULT_URL;
  let mcpRemoteBin;
  try {
    mcpRemoteBin = resolveMcpRemoteBin();
  } catch (err) {
    // Nothing has been written yet, so fail()'s inline exit is safe here.
    fail(err.message);
  }

  // Extra args (e.g. --debug) pass straight through to mcp-remote.
  const passthrough = process.argv.slice(2);

  const child = spawn(
    process.execPath,
    [mcpRemoteBin, ...bridgeArgs({ keyMode, serverUrl, passthrough })],
    { stdio: ["inherit", "inherit", "pipe"] }
  );

  // Forward stderr while watching for the signatures of failed
  // authentication, so the exit message can name the actual fix. Matching is
  // line-buffered — a signature can span two stream chunks otherwise.
  let sawAuthFailure = false;
  // Set only when WE kill the child for an auth reason. The child may handle
  // that SIGINT and exit 0, so the child's exit result alone can't be
  // trusted to report the failure.
  let authAbort = false;
  let forwardedSignal = null;
  let authTimer = null;
  let killTimer = null;

  // mcp-remote's auth coordinator installs a SIGINT handler that cleans up
  // and never exits (and it ignores SIGTERM outright), so every kill is one
  // signal plus a SIGKILL backstop.
  const endChild = (signal) => {
    child.kill(signal);
    if (!killTimer) {
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      killTimer.unref();
    }
  };

  // NOTE: verifyAuth (lib/connect.js) interprets the same mcp-remote
  // signatures with deliberately different policy — interactive messaging
  // there, headless timeouts and exit codes here. A change to mcp-remote's
  // output lands in BOTH.
  let connected = false;
  const splitter = makeLineSplitter((line) => {
    // Failure signatures only count before the proxy is up — a transient
    // 401 around a token refresh must not turn a later unrelated exit into
    // auth guidance.
    if (!connected && AUTH_FAILURE_RE.test(line)) {
      sawAuthFailure = true;
    }
    if (AUTH_PROMPT_RE.test(line)) {
      if (keyMode) {
        // A rejected key surfaces as a silent 401 that drops mcp-remote into
        // its interactive OAuth fallback — never right for a key user. Bail
        // out instead of hanging on a browser prompt.
        authAbort = true;
        endChild("SIGINT");
      } else if (!authTimer) {
        authTimer = setTimeout(() => {
          authAbort = true;
          endChild("SIGINT");
        }, BRIDGE_AUTH_WAIT_MS);
      }
    }
    if (PROXY_UP_RE.test(line)) {
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      connected = true;
      sawAuthFailure = false;
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    splitter.push(chunk);
  });

  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of forwardedSignals) {
    process.on(signal, () => {
      forwardedSignal = signal;
      // endChild's SIGKILL backstop covers mcp-remote ignoring SIGTERM,
      // which would otherwise orphan both processes on a harness stop.
      endChild(signal);
    });
  }

  // `close`, not `exit`: it fires after the stderr pipe drains, so trailing
  // authentication output still reaches the matcher. Exit via exitCode, not
  // process.exit(), so our own piped stderr drains before termination.
  child.on("close", (code, signal) => {
    splitter.flush();
    if (authTimer) clearTimeout(authTimer);
    if (killTimer) clearTimeout(killTimer);
    if (authAbort) {
      // We ended the session over auth; the child's own exit code (often 0,
      // from its SIGINT handler) must not report success.
      writeAuthGuidance(keyMode);
      process.exitCode = 1;
      return;
    }
    if (forwardedSignal) {
      // The user (or supervisor) stopped us — re-raise with the default
      // disposition restored so the signal terminates the process normally,
      // whatever stderr happened to contain.
      for (const s of forwardedSignals) process.removeAllListeners(s);
      process.kill(process.pid, forwardedSignal);
      return;
    }
    if (code !== 0 && sawAuthFailure) {
      writeAuthGuidance(keyMode);
    }
    process.exitCode = signal ? 1 : code === null ? 1 : code;
  });

  child.on("error", (err) => {
    fail(`failed to start mcp-remote: ${err.message}`);
  });
}

const subcommand = process.argv[2];
if (subcommand === "connect-buzz" || subcommand === "connect") {
  require("../lib/connect.js")
    .run(process.argv.slice(3))
    .then((code) => {
      // exitCode, not process.exit(): a piped stderr must drain first.
      process.exitCode = code;
    })
    .catch((err) => {
      // Not fail() — its inline exit would discard run()'s still-buffered
      // progress output on a piped stderr.
      process.stderr.write(`vibewatch-mcp: ${err.message}\n`);
      process.exitCode = 1;
    });
} else {
  runBridge();
}
