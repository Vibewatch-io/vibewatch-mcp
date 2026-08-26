import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { noAutoOpenShimPath } = require("../lib/common.js");

// The --require shim the bridge preloads into mcp-remote (issue #10):
// intercepts the `open` package's platform-opener spawn so mcp-remote can
// never open a browser itself.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function runShimmed(script, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-shim-"));
  const logPath = path.join(tmp, "suppressed.log");
  const result = spawnSync(
    process.execPath,
    ["--require", noAutoOpenShimPath(), "-e", script],
    {
      encoding: "utf8",
      cwd: repoRoot, // so -e scripts can require the vendored `open` package
      env: {
        ...process.env,
        VIBEWATCH_MCP_SUPPRESS_BROWSER_OPEN: "1",
        VIBEWATCH_MCP_SUPPRESS_LOG: logPath,
        ...env,
      },
      timeout: 15_000,
    }
  );
  const suppressed = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    : [];
  return { result, suppressed };
}

test("opener basenames are replaced with a no-op child that exits 0", () => {
  const { result, suppressed } = runShimmed(`
    const cp = require("node:child_process");
    const child = cp.spawn("xdg-open", ["https://example.test/a"], {stdio: "ignore"});
    child.on("error", (e) => { console.error("spawn error", e); process.exit(3); });
    child.on("close", (code) => process.exit(code === 0 ? 0 : 4));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].command, "xdg-open");
  assert.match(result.stderr, /suppressed mcp-remote's browser auto-open/);
});

test("the bundled-absolute-path xdg-open variant is caught too", () => {
  const fakeBundled = "/some/dir/node_modules/open/xdg-open";
  const { result, suppressed } = runShimmed(`
    const cp = require("node:child_process");
    const child = cp.spawn(${JSON.stringify(fakeBundled)}, ["https://example.test/b"], {stdio: "ignore", detached: true});
    child.on("error", () => process.exit(3));
    child.on("close", () => process.exit(0));
    child.unref();
    setTimeout(() => process.exit(0), 2000);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(suppressed.length, 1);
});

test("non-opener spawns pass through untouched", () => {
  const { result, suppressed } = runShimmed(`
    const cp = require("node:child_process");
    const child = cp.spawn(process.execPath, ["-e", "process.exit(7)"]);
    child.on("close", (code) => process.exit(code));
  `);
  assert.equal(result.status, 7);
  assert.equal(suppressed.length, 0);
});

test("the real vendored `open` package cannot reach a browser under the shim", async () => {
  // Through the actual dependency mcp-remote bundles its logic from: open()
  // must resolve without the platform opener ever running.
  const { result, suppressed } = runShimmed(`
    import("open").then(async ({default: open}) => {
      await open("https://example.test/real-open");
      process.exit(0);
    }).catch((err) => { console.error(err); process.exit(3); });
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(suppressed.length, 1, "the opener spawn must be intercepted");
});

test("without the env flag the shim is inert", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-shim-"));
  const logPath = path.join(tmp, "suppressed.log");
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      noAutoOpenShimPath(),
      "-e",
      `
      const cp = require("node:child_process");
      // A nonsense opener name: with the shim inert this spawn fails with
      // ENOENT (proving no interception), never a clean no-op exit.
      const child = cp.spawn("xdg-open-definitely-missing-vw", ["x"]);
      child.on("error", () => process.exit(5));
      child.on("close", () => process.exit(6));
      `,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, VIBEWATCH_MCP_SUPPRESS_LOG: logPath },
      timeout: 15_000,
    }
  );
  assert.equal(result.status, 5);
  assert.equal(fs.existsSync(logPath), false);
});
