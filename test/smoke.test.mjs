import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const bin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "vibewatch-mcp.js"
);

test("fails fast with a clear message when VIBEWATCH_MCP_KEY is unset", () => {
  const env = { ...process.env };
  delete env.VIBEWATCH_MCP_KEY;
  const result = spawnSync(process.execPath, [bin], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VIBEWATCH_MCP_KEY is not set/);
  assert.match(result.stderr, /Settings → API Access/);
});

test("key placeholder, not the key value, is what would reach argv", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(bin, "utf8")
  );
  assert.match(source, /Authorization: Bearer \$\{VIBEWATCH_MCP_KEY\}/);
});
