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
  const savedKey = process.env.VIBEWATCH_MCP_KEY;
  const savedUrl = process.env.VIBEWATCH_MCP_URL;
  delete process.env.VIBEWATCH_MCP_KEY;
  delete process.env.VIBEWATCH_MCP_URL;
  try {
    const opts = connect.parseArgs([]);
    assert.equal(opts.key, null);
    assert.equal(opts.url, DEFAULT_URL);
    assert.equal(opts.harnesses, null);
    assert.equal(opts.reset, false);
  } finally {
    // Restore keys individually — replacing process.env wholesale de-syncs
    // it from the real environment.
    if (savedKey !== undefined) process.env.VIBEWATCH_MCP_KEY = savedKey;
    if (savedUrl !== undefined) process.env.VIBEWATCH_MCP_URL = savedUrl;
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
  // registrationEnv passes through an ambient MCP_REMOTE_CONFIG_DIR —
  // clear it so the assertion holds on machines that export one.
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  delete process.env.MCP_REMOTE_CONFIG_DIR;
  try {
    assert.deepEqual(
      connect.registrationEnv({ key: null, url: DEFAULT_URL }),
      {}
    );
  } finally {
    if (saved !== undefined) process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
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

test("findOnPath finds the running node and misses nonsense", () => {
  // Search for the actual executable running this test, with its directory
  // added to PATH — CI runners may invoke node via an absolute path.
  const execDir = path.dirname(process.execPath);
  const execName = path.basename(process.execPath);
  const savedPath = process.env.PATH;
  process.env.PATH = `${execDir}${path.delimiter}${savedPath || ""}`;
  try {
    assert.ok(connect.findOnPath(execName));
    assert.equal(connect.findOnPath("definitely-not-a-real-binary-xyz"), null);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("a malformed env key is dropped with a warning flag, not fatal", () => {
  const saved = process.env.VIBEWATCH_MCP_KEY;
  process.env.VIBEWATCH_MCP_KEY = "none";
  try {
    const opts = connect.parseArgs([]);
    assert.equal(opts.key, null);
    assert.equal(opts.envKeyIgnored, true);
  } finally {
    if (saved !== undefined) process.env.VIBEWATCH_MCP_KEY = saved;
    else delete process.env.VIBEWATCH_MCP_KEY;
  }
});

test("parseArgs rejects a malformed key", () => {
  assert.throws(
    () => connect.parseArgs(["--key", "not-a-key"]),
    /vw_mcp_/
  );
  assert.throws(
    () => connect.parseArgs(["--key", 'vw_mcp_abc"&whoami']),
    /vw_mcp_/
  );
});

test("parseArgs rejects unsafe or unparseable URLs", () => {
  assert.throws(() => connect.parseArgs(["--url", "not a url"]), /valid URL/);
  assert.throws(
    () => connect.parseArgs(["--url", "ftp://example.test/mcp/"]),
    /https/
  );
  assert.throws(
    () => connect.parseArgs(["--url", 'https://example.test/mcp/"&whoami']),
    /can't pass through safely/
  );
});

test("parseArgs allows http only for localhost", () => {
  // mcp-remote refuses non-local plain http, so accepting it here would
  // just fail later with a worse message.
  const opts = connect.parseArgs(["--url", "http://localhost:8000/mcp/"]);
  assert.equal(opts.url, "http://localhost:8000/mcp/");
  assert.throws(
    () => connect.parseArgs(["--url", "http://example.internal/mcp/"]),
    /only allowed for localhost/
  );
  // Mirrors mcp-remote's own allowlist, which excludes IPv6 loopback.
  assert.throws(
    () => connect.parseArgs(["--url", "http://[::1]:8000/mcp/"]),
    /only allowed for localhost/
  );
});

test("auth-failure regex ignores 401 inside a port number", async () => {
  const { AUTH_FAILURE_RE } = require("../lib/common.js");
  assert.equal(
    AUTH_FAILURE_RE.test(
      "[123] OAuth callback server running at http://127.0.0.1:3401"
    ),
    false
  );
  assert.ok(AUTH_FAILURE_RE.test("Error POSTing to endpoint (HTTP 401)"));
  assert.ok(AUTH_FAILURE_RE.test("Server responded: Unauthorized"));
});
