import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { upsertVibewatchExtension } = require("../lib/goose-config.js");
const YAML = require("yaml");

test("adds the extension to an empty config", () => {
  const out = upsertVibewatchExtension("");
  const parsed = YAML.parse(out);
  assert.equal(parsed.extensions.vibewatch.cmd, "vibewatch-mcp");
  assert.equal(parsed.extensions.vibewatch.type, "stdio");
  assert.equal(parsed.extensions.vibewatch.enabled, true);
  assert.deepEqual(parsed.extensions.vibewatch.envs, {});
});

test("adds the extension to Buzz's default empty-extensions config", () => {
  const out = upsertVibewatchExtension("extensions: {}\n");
  const parsed = YAML.parse(out);
  assert.equal(parsed.extensions.vibewatch.cmd, "vibewatch-mcp");
});

test("preserves unrelated keys and comments", () => {
  const input = [
    "# provider settings",
    "GOOSE_PROVIDER: anthropic",
    "extensions:",
    "  developer:",
    "    enabled: true",
    "    type: builtin",
    "    name: developer",
    "",
  ].join("\n");
  const out = upsertVibewatchExtension(input);
  assert.match(out, /# provider settings/);
  const parsed = YAML.parse(out);
  assert.equal(parsed.GOOSE_PROVIDER, "anthropic");
  assert.equal(parsed.extensions.developer.enabled, true);
  assert.equal(parsed.extensions.vibewatch.cmd, "vibewatch-mcp");
});

test("replaces an existing vibewatch entry instead of duplicating", () => {
  const first = upsertVibewatchExtension("", {
    envs: { VIBEWATCH_MCP_KEY: "vw_mcp_old" },
  });
  const second = upsertVibewatchExtension(first, { envs: {} });
  const parsed = YAML.parse(second);
  assert.deepEqual(parsed.extensions.vibewatch.envs, {});
  assert.equal(
    (second.match(/vibewatch:/g) || []).length,
    1,
    "one vibewatch entry only"
  );
});

test("carries key and URL envs when provided", () => {
  const out = upsertVibewatchExtension("", {
    envs: {
      VIBEWATCH_MCP_KEY: "vw_mcp_abc",
      VIBEWATCH_MCP_URL: "https://example.test/mcp/",
    },
  });
  const parsed = YAML.parse(out);
  assert.equal(parsed.extensions.vibewatch.envs.VIBEWATCH_MCP_KEY, "vw_mcp_abc");
  assert.equal(
    parsed.extensions.vibewatch.envs.VIBEWATCH_MCP_URL,
    "https://example.test/mcp/"
  );
});

test("throws on unparseable YAML rather than clobbering the file", () => {
  assert.throws(
    () => upsertVibewatchExtension("extensions: [unclosed"),
    /could not parse Goose config/
  );
});
