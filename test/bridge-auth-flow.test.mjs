import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DEFAULT_URL, authMarkerPath } = require("../lib/common.js");

// The real bridge run against a fake mcp-remote that replays auth stderr
// signatures (see test/fixtures/) — exercises the marker write/clear paths
// that the pure-unit tests can't reach.
const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures"
);

function runBridge(tmp, script, extraEnv = {}) {
  const env = {
    ...process.env,
    MCP_REMOTE_CONFIG_DIR: tmp,
    VW_TEST_FAKE_MCP_REMOTE: path.join(fixtures, "fake-mcp-remote.cjs"),
    VW_TEST_SCRIPT: script,
    ...extraEnv,
  };
  delete env.VIBEWATCH_MCP_KEY;
  delete env.VIBEWATCH_MCP_URL;
  return spawnSync(
    process.execPath,
    [path.join(fixtures, "bridge-driver.cjs")],
    { encoding: "utf8", env, timeout: 30_000 }
  );
}

function markerFor(tmp) {
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  process.env.MCP_REMOTE_CONFIG_DIR = tmp;
  try {
    return authMarkerPath(DEFAULT_URL);
  } finally {
    if (saved === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
}

test("bridge writes the marker when the authorize prompt appears", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-bridge-"));
  const result = runBridge(tmp, "prompt");
  assert.equal(result.status, 0);
  assert.ok(
    existsSync(markerFor(tmp)),
    "an opened-but-uncompleted prompt must leave a marker for the next spawn"
  );
});

test("bridge writes the marker on the shared-auth wait line too", () => {
  // The loser of a sign-in lockfile race never sees the authorize-URL
  // prompt, but the winner's tab is open — this spawn must count as the
  // one attempt as well.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-bridge-"));
  runBridge(tmp, "wait");
  assert.ok(existsSync(markerFor(tmp)));
});

test("bridge clears the marker once the proxy comes up", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-bridge-"));
  const result = runBridge(tmp, "prompt,proxy-up");
  assert.equal(result.status, 0);
  assert.equal(
    existsSync(markerFor(tmp)),
    false,
    "a completed sign-in must lift the one-prompt cap"
  );
});

test("bridge with a completed prior session leaves no suppression for the next", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-bridge-"));
  runBridge(tmp, "prompt,proxy-up");
  // Next spawn: no marker → gate is clear → it must reach the (fake)
  // mcp-remote rather than exiting suppressed.
  const result = runBridge(tmp, "proxy-up");
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /already opened and never completed/);
});

test("bridge auth-failure exit still prints guidance (regression)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-bridge-"));
  const result = runBridge(tmp, "auth-fail", { VW_TEST_EXIT: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not signed in|connect-buzz/);
});

// --- claim wiring (forced on via VW_TEST_CLAIM; win32-only in production) ---

test("claim-enabled bridge: acquires, connects, and releases the claim", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-bridge-"));
  const result = runBridge(tmp, "prompt,proxy-up", { VW_TEST_CLAIM: "1" });
  assert.equal(result.status, 0);
  const { claimPath } = require("../lib/common.js");
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  process.env.MCP_REMOTE_CONFIG_DIR = tmp;
  try {
    assert.equal(existsSync(claimPath(DEFAULT_URL)), false);
  } finally {
    if (saved === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
});

test("claim-enabled bridge: a live foreign claim makes it wait, then exit named", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-bridge-"));
  const { claimPath } = require("../lib/common.js");
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  process.env.MCP_REMOTE_CONFIG_DIR = tmp;
  try {
    writeFileSync(
      claimPath(DEFAULT_URL),
      JSON.stringify({
        ownerId: "999-feedface0000",
        claimedAt: Date.now(),
        renewedAt: Date.now(),
      })
    );
  } finally {
    if (saved === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
  const result = runBridge(tmp, "proxy-up", { VW_TEST_CLAIM: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still connecting or signing in/);
});
