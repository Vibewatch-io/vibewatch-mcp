import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repoRoot, "plugins", "vibewatch");

const CANONICAL_SERVERS = {
  vibewatch: {
    type: "http",
    url: "https://api.vibewatch.io/mcp/",
  },
};

function collectJsonFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectJsonFiles(full));
    else if (entry.endsWith(".json")) out.push(full);
  }
  return out;
}

const manifestFiles = [
  ...collectJsonFiles(pluginRoot),
  join(repoRoot, ".claude-plugin", "marketplace.json"),
  join(repoRoot, ".cursor-plugin", "marketplace.json"),
  join(repoRoot, ".agents", "plugins", "marketplace.json"),
];

test("every plugin manifest is valid JSON", () => {
  for (const file of manifestFiles) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, "utf8")), file);
  }
});

test("every mcp.json declares the identical canonical server", () => {
  const mcpFiles = manifestFiles.filter((f) => f.endsWith("mcp.json"));
  assert.ok(mcpFiles.length >= 3, "expected the per-ecosystem mcp.json copies");
  for (const file of mcpFiles) {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(parsed.mcpServers, CANONICAL_SERVERS, file);
  }
});

test("every plugin.json carries the same version and name", () => {
  const pluginFiles = manifestFiles.filter((f) => f.endsWith("plugin.json"));
  assert.ok(pluginFiles.length >= 4, "expected one plugin.json per ecosystem");
  const versions = new Set();
  for (const file of pluginFiles) {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.name, "vibewatch", file);
    assert.ok(/^\d+\.\d+\.\d+$/.test(parsed.version), `${file}: semver version`);
    versions.add(parsed.version);
    assert.ok(parsed.description.length > 0, `${file}: description`);
    assert.equal(parsed.license, "Apache-2.0", file);
  }
  assert.equal(versions.size, 1, `plugin versions drifted: ${[...versions]}`);
});

test("no manifest contains a key, secret, or non-production URL", () => {
  for (const file of manifestFiles) {
    const raw = readFileSync(file, "utf8");
    assert.ok(!/vw_mcp_/.test(raw), `${file}: contains an MCP key`);
    assert.ok(!/railway\.app|up\.railway|localhost|127\.0\.0\.1/.test(raw), `${file}: non-production URL`);
  }
});
