import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DEFAULT_URL, readFreshAuthMarker } = require("../lib/common.js");

// Bridge-owned browser opening (issue #10): the real bridge run against the
// fake mcp-remote, with the driver's openBrowser stub recording each
// would-be open into VW_TEST_OPEN_LOG.
const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures"
);

function bridgeEnv(tmp, script, extraEnv = {}) {
  const env = {
    ...process.env,
    MCP_REMOTE_CONFIG_DIR: tmp,
    VW_TEST_FAKE_MCP_REMOTE: path.join(fixtures, "fake-mcp-remote.cjs"),
    VW_TEST_SCRIPT: script,
    VW_TEST_OPEN_LOG: path.join(tmp, "opens.log"),
  };
  // The ambient environment must not leak key/url config into the tests —
  // but a test explicitly passing them (key-mode cases) wins.
  delete env.VIBEWATCH_MCP_KEY;
  delete env.VIBEWATCH_MCP_URL;
  return { ...env, ...extraEnv };
}

function runBridge(tmp, script, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [path.join(fixtures, "bridge-driver.cjs")],
    { encoding: "utf8", env: bridgeEnv(tmp, script, extraEnv), timeout: 30_000 }
  );
}

function runBridgeAsync(tmp, script, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(fixtures, "bridge-driver.cjs")],
      { env: bridgeEnv(tmp, script, extraEnv), stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ status: code, stderr }));
  });
}

function opens(tmp) {
  try {
    return fs
      .readFileSync(path.join(tmp, "opens.log"), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function markerKind(tmp) {
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  process.env.MCP_REMOTE_CONFIG_DIR = tmp;
  try {
    const marker = readFreshAuthMarker(DEFAULT_URL);
    return marker && marker.kind;
  } finally {
    if (saved === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
}

test("the prompt owner opens exactly one tab, with the URL from the prompt", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const result = runBridge(tmp, "prompt");
  assert.equal(result.status, 0);
  assert.deepEqual(opens(tmp), [
    "https://example.test/authorize?request_id=fixture&client_id=abc",
  ]);
  assert.match(result.stderr, /opened the Vibewatch sign-in page/);
  assert.equal(markerKind(tmp), "opened");
});

test("two live bridges prompting in one phase open ONE tab total (the issue-#10 storm)", async () => {
  // Both bridges pass the spawn gate (no marker exists yet), as live
  // sessions do before a mass 401. The early one prompts and claims; the
  // late one's prompt finds the fresh `opened` marker and must not open.
  // The late bridge STARTS first (its spawn-gate check must run before any
  // marker exists — startup timing would otherwise race the early bridge's
  // marker write) but prompts a comfortable margin after the early one.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const latePromise = runBridgeAsync(tmp, "prompt", {
    VW_TEST_LINE_DELAY_MS: "2000",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const earlyPromise = runBridgeAsync(tmp, "prompt", {
    VW_TEST_LINE_DELAY_MS: "100",
  });
  const [early, late] = await Promise.all([earlyPromise, latePromise]);
  assert.equal(early.status, 0);
  assert.equal(late.status, 0);
  assert.equal(opens(tmp).length, 1, "exactly one tab across both bridges");
  assert.match(late.stderr, /already open from another session/);
});

test("mid-session re-auth (proxy-up, then prompt) opens once", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const result = runBridge(tmp, "proxy-up,prompt");
  assert.equal(result.status, 0);
  assert.equal(opens(tmp).length, 1);
  assert.equal(markerKind(tmp), "opened");
});

test("wait line first, then own prompt: the wait marker is upgraded and the tab opens", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const result = runBridge(tmp, "wait,prompt");
  assert.equal(result.status, 0);
  assert.equal(opens(tmp).length, 1);
  assert.equal(markerKind(tmp), "opened");
});

test("a failing opener prints copy-the-URL guidance", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const result = runBridge(tmp, "prompt", { VW_TEST_OPEN_FAIL: "1" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /could not open a browser/);
});

test("key mode never opens a browser", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const result = runBridge(tmp, "prompt", {
    VIBEWATCH_MCP_KEY: "vw_mcp_testkey",
  });
  assert.equal(result.status, 1); // rejected-key abort path
  assert.deepEqual(opens(tmp), []);
});
