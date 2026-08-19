import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { bridgeArgs } = require("../lib/common.js");

const bin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "vibewatch-mcp.js"
);

test("bridgeArgs: key mode sends the placeholder header, never the key", () => {
  const args = bridgeArgs({
    keyMode: true,
    serverUrl: "https://api.vibewatch.io/mcp/",
  });
  assert.ok(args.includes("--header"));
  assert.ok(args.includes("Authorization: Bearer ${VIBEWATCH_MCP_KEY}"));
  assert.ok(!args.some((a) => a.includes("vw_mcp_")));
});

test("bridgeArgs: OAuth mode sends no header, so cached sign-in applies", () => {
  const args = bridgeArgs({
    keyMode: false,
    serverUrl: "https://api.vibewatch.io/mcp/",
    passthrough: ["--debug"],
  });
  assert.ok(!args.includes("--header"));
  assert.deepEqual(args.slice(0, 3), [
    "https://api.vibewatch.io/mcp/",
    "--transport",
    "http-only",
  ]);
  assert.equal(args.at(-1), "--debug");
});

test("connect-buzz --help prints usage and exits 0", () => {
  const result = spawnSync(process.execPath, [bin, "connect-buzz", "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Usage: vibewatch-mcp connect-buzz/);
  assert.match(result.stderr, /--reset/);
});

test("connect-buzz rejects an unknown option with exit 2", () => {
  const result = spawnSync(
    process.execPath,
    [bin, "connect-buzz", "--bogus"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option/);
});

test("connect-buzz rejects a malformed key before any network call", () => {
  const result = spawnSync(
    process.execPath,
    [bin, "connect-buzz", "--key", "not-a-key"],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH } }
  );
  // parseArgs rejects the malformed key before the global-install check,
  // so this message always fires regardless of PATH state.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /vw_mcp_/);
});
