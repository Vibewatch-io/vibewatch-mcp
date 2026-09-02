import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DEFAULT_URL } = require("../lib/common.js");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repoRoot, "plugins", "vibewatch");

const CANONICAL_SERVERS = {
  vibewatch: {
    type: "http",
    url: DEFAULT_URL,
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

test("marketplace manifests point at directories that exist", () => {
  const marketplaceFiles = manifestFiles.filter((f) => f.endsWith("marketplace.json"));
  assert.equal(marketplaceFiles.length, 3, "expected the three root marketplace manifests");
  for (const file of marketplaceFiles) {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    for (const plugin of parsed.plugins) {
      const ref = typeof plugin.source === "string" ? plugin.source : plugin.source?.path;
      assert.ok(ref, `${file}: plugin entry has no source path`);
      const resolved = join(repoRoot, ref);
      assert.ok(existsSync(join(resolved, "skills")), `${file}: ${ref} missing skills/`);
      assert.ok(existsSync(join(resolved, ".mcp.json")), `${file}: ${ref} missing .mcp.json`);
    }
  }
});

test("plugin manifests' internal file references resolve", () => {
  const pluginFiles = manifestFiles.filter((f) => f.endsWith("plugin.json"));
  for (const file of pluginFiles) {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const refs = [
      parsed.mcpServers,
      parsed.skills,
      parsed.logo,
      parsed.interface?.composerIcon,
      parsed.interface?.logo,
    ];
    for (const ref of refs) {
      if (typeof ref !== "string") continue;
      assert.ok(existsSync(join(pluginRoot, ref)), `${file}: missing referenced path ${ref}`);
    }
  }
});

test("the skill ships with parseable frontmatter", () => {
  const skillFile = join(pluginRoot, "skills", "use-vibewatch", "SKILL.md");
  assert.ok(existsSync(skillFile), "skills/use-vibewatch/SKILL.md missing");
  const raw = readFileSync(skillFile, "utf8");
  const frontmatter = raw.match(/^---\n([\s\S]+?)\n---\n/);
  assert.ok(frontmatter, "SKILL.md has no frontmatter block");
  assert.match(frontmatter[1], /^name: use-vibewatch$/m, "frontmatter name");
  assert.match(frontmatter[1], /^description: /m, "frontmatter description");
});

test("no shipped plugin file contains a key, secret, or non-production URL", () => {
  const scanned = [
    ...manifestFiles,
    join(pluginRoot, "skills", "use-vibewatch", "SKILL.md"),
  ];
  for (const file of scanned) {
    const raw = readFileSync(file, "utf8");
    assert.ok(!/vw_mcp_[A-Za-z0-9._-]/.test(raw), `${file}: contains an MCP key`);
    assert.ok(!/railway\.app|up\.railway|localhost|127\.0\.0\.1/.test(raw), `${file}: non-production URL`);
  }
});
