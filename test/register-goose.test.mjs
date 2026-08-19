import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  symlinkSync,
  chmodSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const connect = require("../lib/connect.js");
const YAML = require("yaml");

// registerGoose is the only code here that rewrites a file the user owns —
// exercise the real fs sequence via XDG_CONFIG_HOME (honoured on POSIX).
const posixOnly = process.platform === "win32" ? { skip: true } : {};

function withTempConfigHome(fn) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-goose-"));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  try {
    return fn(path.join(tmp, "goose", "config.yaml"));
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
}

const OPTS = { key: null, url: "https://api.vibewatch.io/mcp/" };

test("creates the config when missing: no backup, owner-only mode", posixOnly, () => {
  withTempConfigHome((configPath) => {
    const result = connect.registerGoose(OPTS);
    assert.equal(result.status, "configured");
    assert.equal(result.detail, undefined);
    const parsed = YAML.parse(readFileSync(configPath, "utf8"));
    assert.equal(parsed.extensions.vibewatch.type, "stdio");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(existsSync(`${configPath}.vibewatch-bak`), false);
  });
});

test("rewrites an existing config: backup kept, comments survive", posixOnly, () => {
  withTempConfigHome((configPath) => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, "# mine\nGOOSE_PROVIDER: anthropic\n");
    const result = connect.registerGoose(OPTS);
    assert.equal(result.status, "configured");
    assert.match(result.detail, /vibewatch-bak/);
    const out = readFileSync(configPath, "utf8");
    assert.match(out, /# mine/);
    const parsed = YAML.parse(out);
    assert.equal(parsed.GOOSE_PROVIDER, "anthropic");
    assert.ok(parsed.extensions.vibewatch);
    const bak = `${configPath}.vibewatch-bak`;
    assert.equal(readFileSync(bak, "utf8"), "# mine\nGOOSE_PROVIDER: anthropic\n");
    assert.equal(statSync(bak).mode & 0o777, 0o600);
  });
});

// chmod 0o000 does not stop root from reading, so this scenario can't be
// simulated in root-run CI containers.
const posixNonRoot =
  process.platform === "win32" || process.getuid?.() === 0
    ? { skip: true }
    : {};

test("an unreadable config fails instead of being replaced", posixNonRoot, (t) => {
  withTempConfigHome((configPath) => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, "GOOSE_PROVIDER: anthropic\n");
    chmodSync(configPath, 0o000);
    try {
      // Some filesystems (certain container mounts) don't enforce the deny
      // even for non-root — probe first and skip when the scenario can't
      // be produced, rather than asserting a failure that won't happen.
      try {
        readFileSync(configPath, "utf8");
        t.skip("filesystem does not enforce mode 0o000 for this user");
        return;
      } catch {
        /* deny holds — proceed */
      }
      const result = connect.registerGoose(OPTS);
      assert.equal(result.status, "failed");
      chmodSync(configPath, 0o600);
      assert.equal(
        readFileSync(configPath, "utf8"),
        "GOOSE_PROVIDER: anthropic\n"
      );
    } finally {
      chmodSync(configPath, 0o600);
    }
  });
});

test("a symlinked config keeps its link; the target is updated", posixOnly, () => {
  withTempConfigHome((configPath) => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    const target = path.join(path.dirname(configPath), "dotfiles-config.yaml");
    writeFileSync(target, "extensions: {}\n");
    symlinkSync(target, configPath);
    const result = connect.registerGoose(OPTS);
    assert.equal(result.status, "configured");
    assert.ok(lstatSync(configPath).isSymbolicLink());
    assert.equal(realpathSync(configPath), realpathSync(target));
    const parsed = YAML.parse(readFileSync(target, "utf8"));
    assert.ok(parsed.extensions.vibewatch);
  });
});
