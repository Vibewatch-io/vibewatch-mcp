import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const bin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "vibewatch-mcp.js"
);

test("key placeholder, not the key value, is what would reach argv", async () => {
  const source = await readFile(bin, "utf8");
  assert.match(source, /Authorization: Bearer \$\{VIBEWATCH_MCP_KEY\}/);
});

test("without a key the bridge spawns in OAuth mode (no header arg)", async () => {
  // The bridge must not send an Authorization header when no key is set —
  // that is what lets mcp-remote fall through to the cached OAuth sign-in.
  const source = await readFile(bin, "utf8");
  assert.match(source, /keyMode\s*\?\s*\["--header"/);
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
  // Either the malformed-key message (global install present) or the
  // install-first message (no global vibewatch-mcp on PATH) — both are
  // pre-network failures.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /vw_mcp_|install globally/);
});
