import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const connect = require("../lib/connect.js");
const { DEFAULT_URL } = require("../lib/common.js");

test("parseArgs defaults: OAuth mode against the production URL", () => {
  const saved = { ...process.env };
  delete process.env.VIBEWATCH_MCP_KEY;
  delete process.env.VIBEWATCH_MCP_URL;
  try {
    const opts = connect.parseArgs([]);
    assert.equal(opts.key, null);
    assert.equal(opts.url, DEFAULT_URL);
    assert.equal(opts.harnesses, null);
    assert.equal(opts.reset, false);
  } finally {
    process.env = saved;
  }
});

test("parseArgs reads --key, --url, --reset and a harness list", () => {
  const opts = connect.parseArgs([
    "--key",
    "vw_mcp_abc",
    "--url",
    "https://vibewatch-rc.up.railway.app/mcp/",
    "--harness",
    "claude, codex",
    "--reset",
  ]);
  assert.equal(opts.key, "vw_mcp_abc");
  assert.equal(opts.url, "https://vibewatch-rc.up.railway.app/mcp/");
  assert.deepEqual(opts.harnesses, ["claude", "codex"]);
  assert.equal(opts.reset, true);
});

test("parseArgs rejects unknown harness names", () => {
  assert.throws(
    () => connect.parseArgs(["--harness", "cursor"]),
    /unknown harness "cursor"/
  );
});

test("parseArgs rejects a flag missing its value", () => {
  assert.throws(() => connect.parseArgs(["--key"]), /needs a value/);
});

test("registrationEnv is empty in plain OAuth mode", () => {
  assert.deepEqual(
    connect.registrationEnv({ key: null, url: DEFAULT_URL }),
    {}
  );
});

test("registrationEnv carries key and non-default URL", () => {
  assert.deepEqual(
    connect.registrationEnv({
      key: "vw_mcp_abc",
      url: "https://example.test/mcp/",
    }),
    {
      VIBEWATCH_MCP_KEY: "vw_mcp_abc",
      VIBEWATCH_MCP_URL: "https://example.test/mcp/",
    }
  );
});

test("resetCachedAuth clears this server's entries across every version dir", () => {
  // mcp-remote's cache dir name comes from a version constant baked into its
  // build, which can lag the package version — so reset scans all of them.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-auth-"));
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  process.env.MCP_REMOTE_CONFIG_DIR = tmp;
  try {
    const { mkdirSync } = require("node:fs");
    const dirA = path.join(tmp, "mcp-remote-0.1.37");
    const dirB = path.join(tmp, "mcp-remote-0.1.38");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const crypto = require("node:crypto");
    const url = "https://example.test/mcp/";
    const hash = crypto.createHash("md5").update(url).digest("hex");
    writeFileSync(path.join(dirA, `${hash}_tokens.json`), "{}");
    writeFileSync(path.join(dirA, "otherhash_tokens.json"), "{}");
    writeFileSync(path.join(dirB, `${hash}_client_info.json`), "{}");
    const removed = connect.resetCachedAuth(url);
    assert.equal(removed, 2);
    assert.deepEqual(readdirSync(dirA), ["otherhash_tokens.json"]);
    assert.deepEqual(readdirSync(dirB), []);
  } finally {
    if (saved === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
});

test("findOnPath finds node and misses nonsense", () => {
  assert.equal(connect.findOnPath("definitely-not-a-real-binary-xyz"), null);
});
