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

test("a failing opener prints guidance and demotes the marker to `wait`", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const result = runBridge(tmp, "prompt", { VW_TEST_OPEN_FAIL: "1" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /could not open a browser/);
  // A stranded `opened` marker would suppress every session for the full
  // TTL with no tab behind it (review P2) — it must read as `wait`.
  assert.equal(markerKind(tmp), "wait");
});

test("after one session's opener fails, a live sibling's prompt still opens the tab", async () => {
  // Same start-order pattern as the storm test: the rescuer starts first
  // (spawn gate must run before any marker exists) but prompts after the
  // failing session has claimed, failed, and demoted its marker to `wait`.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const rescuerPromise = runBridgeAsync(tmp, "prompt", {
    VW_TEST_LINE_DELAY_MS: "2000",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const failing = await runBridgeAsync(tmp, "prompt", {
    VW_TEST_LINE_DELAY_MS: "100",
    VW_TEST_OPEN_FAIL: "1",
  });
  const rescuer = await rescuerPromise;
  assert.match(failing.stderr, /could not open a browser/);
  assert.match(rescuer.stderr, /opened the Vibewatch sign-in page/);
  assert.equal(opens(tmp).length, 1, "the rescuer's tab, exactly once");
  assert.equal(markerKind(tmp), "opened");
});

test("a repeated prompt in one phase (--debug double logging) opens once, no false warning", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const result = runBridge(tmp, "prompt,prompt");
  assert.equal(result.status, 0);
  assert.equal(opens(tmp).length, 1);
  assert.doesNotMatch(result.stderr, /already open from another session/);
});

test("fragmented stderr chunks still yield exactly one extracted URL", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const result = runBridge(tmp, "prompt", { VW_TEST_FRAGMENT: "1" });
  assert.equal(result.status, 0);
  assert.deepEqual(opens(tmp), [
    "https://example.test/authorize?request_id=fixture&client_id=abc",
  ]);
});

test("the bridge's mcp-remote spawn carries the shim: open() inside the child is suppressed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const shimLog = path.join(tmp, "shim.log");
  const result = runBridge(tmp, "open,proxy-up", {
    VIBEWATCH_MCP_SUPPRESS_LOG: shimLog,
  });
  assert.equal(result.status, 0);
  const entries = fs.existsSync(shimLog)
    ? fs.readFileSync(shimLog, "utf8").split("\n").filter(Boolean)
    : [];
  assert.equal(
    entries.length,
    1,
    "the vendored open package's spawn must be intercepted under the bridge"
  );
});

test("a prompt whose URL never arrives still records a `wait` marker", () => {
  // With auto-open suppressed, a URL-less prompt phase must not end with
  // nothing on disk — respawns would re-run the dead phase forever with no
  // issue-#4 suppression (review P2).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const result = runBridge(tmp, "prompt-no-url");
  assert.equal(result.status, 0);
  assert.deepEqual(opens(tmp), []);
  assert.equal(markerKind(tmp), "wait");
});

test("the URL fallback fires while the child is still alive (not only on close)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const done = runBridgeAsync(tmp, "prompt-no-url", {
    VW_TEST_HOLD_MS: "9000",
  });
  // The 5s fallback should have recorded the `wait` marker well before the
  // child exits at ~9s.
  await new Promise((resolve) => setTimeout(resolve, 7_000));
  assert.equal(markerKind(tmp), "wait", "marker present while child lives");
  const result = await done;
  assert.equal(result.status, 0);
  assert.deepEqual(opens(tmp), []);
});

test("key mode never opens a browser", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-open-"));
  const result = runBridge(tmp, "prompt", {
    VIBEWATCH_MCP_KEY: "vw_mcp_testkey",
  });
  assert.equal(result.status, 1); // rejected-key abort path
  assert.deepEqual(opens(tmp), []);
});
