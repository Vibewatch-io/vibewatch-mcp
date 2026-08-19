"use strict";

/**
 * `vibewatch-mcp connect-buzz` — one-command setup for Buzz agents.
 *
 * Signs in to the Vibewatch MCP server via the browser (OAuth) unless a key
 * is supplied, then registers the bridge at user scope in every local agent
 * harness it can find (Claude Code, Codex, Goose). Buzz-spawned agents pick
 * the registration up from the harness's own user config — Buzz sets no
 * config-dir redirects, so the user-scope entry is what its agents load.
 */

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DEFAULT_URL, resolveMcpRemoteBin } = require("./common.js");
const { upsertVibewatchExtension } = require("./goose-config.js");

const HARNESSES = ["claude", "codex", "goose"];
const AUTH_WAIT_MS = 240_000;

const USAGE = `Usage: vibewatch-mcp connect-buzz [options]

Connect your Buzz agents (and any local Claude Code, Codex, or Goose
sessions) to your Vibewatch community-sentiment data.

By default this signs you in via the browser — no key to mint or copy.
Approve access once, and the sign-in is cached for headless reuse.

Options:
  --key <vw_mcp_...>   Use an org key instead of browser sign-in (headless /
                       CI). Also read from VIBEWATCH_MCP_KEY.
  --url <url>          Connect to a non-default server (staging /
                       self-hosted). Also read from VIBEWATCH_MCP_URL.
  --harness <list>     Only configure these harnesses (comma-separated:
                       claude,codex,goose). Default: all detected.
  --reset              Clear the cached sign-in for this server first — use
                       this to switch organizations.
  --dry-run            Sign in and show what would be configured, without
                       touching any harness config.
  -h, --help           Show this help.
`;

function parseArgs(argv) {
  const opts = {
    key: process.env.VIBEWATCH_MCP_KEY || null,
    url: process.env.VIBEWATCH_MCP_URL || DEFAULT_URL,
    harnesses: null,
    reset: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--reset") {
      opts.reset = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--key" || arg === "--url" || arg === "--harness") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`${arg} needs a value (see --help)`);
      }
      if (arg === "--key") opts.key = value;
      if (arg === "--url") opts.url = value;
      if (arg === "--harness") {
        opts.harnesses = value
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean);
        const unknown = opts.harnesses.filter((h) => !HARNESSES.includes(h));
        if (unknown.length > 0) {
          throw new Error(
            `unknown harness "${unknown[0]}" — valid values: ${HARNESSES.join(", ")}`
          );
        }
      }
    } else {
      throw new Error(`unknown option "${arg}" (see --help)`);
    }
  }
  return opts;
}

/** Find an executable on PATH (PATHEXT-aware for Windows). */
function findOnPath(command) {
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * mcp-remote keys its token cache by an md5 of the server URL inside a
 * directory named for a version constant baked into its build. That constant
 * can lag the package version (0.1.38 ships with "0.1.37" embedded), so
 * --reset scans every mcp-remote-* directory rather than computing one —
 * clearing this server's sign-in wherever any mcp-remote build cached it.
 */
function authCacheBase() {
  return (
    process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), ".mcp-auth")
  );
}

function resetCachedAuth(serverUrl) {
  const hash = crypto.createHash("md5").update(serverUrl).digest("hex");
  const base = authCacheBase();
  let removed = 0;
  let versionDirs;
  try {
    versionDirs = fs
      .readdirSync(base)
      .filter((d) => d.startsWith("mcp-remote-"));
  } catch {
    return 0;
  }
  for (const versionDir of versionDirs) {
    const dir = path.join(base, versionDir);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(`${hash}_`)) {
        fs.rmSync(path.join(dir, entry), { force: true });
        removed++;
      }
    }
  }
  return removed;
}

/**
 * Spawn the bundled mcp-remote against the server and wait for its proxy to
 * come up. This is both the verification (the handshake worked) and, in
 * OAuth mode, the seeding step: the sign-in lands in the same version-keyed
 * cache the bridge will read, so later Buzz-spawned sessions start with
 * zero prompts.
 */
function verifyAuth({ url, key }) {
  return new Promise((resolve, reject) => {
    const args = [
      resolveMcpRemoteBin(),
      url,
      "--transport",
      "http-only",
      "--auth-timeout",
      String(Math.floor(AUTH_WAIT_MS / 1000)),
    ];
    if (key) {
      args.push("--header", "Authorization: Bearer ${VIBEWATCH_MCP_KEY}");
    }
    const child = spawn(process.execPath, args, {
      env: key ? { ...process.env, VIBEWATCH_MCP_KEY: key } : process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let settled = false;
    let sawAuthPrompt = false;
    let buffer = "";
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGINT");
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          sawAuthPrompt
            ? "timed out waiting for the browser sign-in. Re-run " +
              "`vibewatch-mcp connect-buzz` to try again."
            : "could not reach the Vibewatch MCP server. Check your network " +
              "and try again."
        )
      );
    }, AUTH_WAIT_MS + 10_000);

    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (/Please authorize this client by visiting/.test(line)) {
          if (key) {
            // A valid key never triggers the OAuth fallback — this line means
            // the server rejected the key.
            finish(
              reject,
              new Error(
                "the server rejected this key. Check it (keys start with " +
                  "vw_mcp_), or mint a new one in app.vibewatch.io → " +
                  "Settings → API Access."
              )
            );
            return;
          }
          sawAuthPrompt = true;
          process.stderr.write(
            "\nOpening your browser to sign in to Vibewatch — approve access " +
              "in the tab that opens.\n"
          );
        } else if (sawAuthPrompt && /^https?:\/\//.test(line)) {
          process.stderr.write(`If no tab opened, visit:\n  ${line}\n\n`);
        } else if (/Proxy established successfully/.test(line)) {
          finish(resolve, { signedIn: sawAuthPrompt });
        } else if (
          /401|Unauthorized|Requested scopes are not valid|InvalidClientMetadataError|Authentication timed out/i.test(
            line
          )
        ) {
          finish(
            reject,
            new Error(
              key
                ? "the server rejected this key. Check it (keys start with " +
                  "vw_mcp_), or mint a new one in app.vibewatch.io → " +
                  "Settings → API Access."
                : "sign-in failed. MCP access is opt-in per organization — " +
                  "an owner or admin can enable it in app.vibewatch.io → " +
                  "Settings → API Access. Then re-run this command."
            )
          );
        }
      }
    });
    child.on("error", (err) =>
      finish(reject, new Error(`failed to start mcp-remote: ${err.message}`))
    );
    child.on("exit", (code) => {
      if (!settled) {
        finish(
          reject,
          new Error(
            `the connection check exited early (code ${code}). Re-run with ` +
              "--help for options, or set VIBEWATCH_MCP_KEY to use a key instead."
          )
        );
      }
    });
  });
}

function runCli(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    shell: process.platform === "win32",
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

/** Env entries every registration shares: key and/or URL when non-default. */
function registrationEnv({ key, url }) {
  const env = {};
  if (key) env.VIBEWATCH_MCP_KEY = key;
  if (url !== DEFAULT_URL) env.VIBEWATCH_MCP_URL = url;
  return env;
}

function registerClaude(opts) {
  const env = registrationEnv(opts);
  // Reconfigure = remove + add; a missing entry makes remove fail, which is
  // fine. User scope only — local/project entries are not ours to touch.
  runCli("claude", ["mcp", "remove", "--scope", "user", "vibewatch"]);
  const args = ["mcp", "add", "--scope", "user", "vibewatch"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push("--", "vibewatch-mcp");
  const result = runCli("claude", args);
  return result.ok
    ? { status: "configured" }
    : { status: "failed", detail: result.output };
}

function registerCodex(opts) {
  const env = registrationEnv(opts);
  runCli("codex", ["mcp", "remove", "vibewatch"]);
  const args = ["mcp", "add", "vibewatch"];
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  args.push("--", "vibewatch-mcp");
  const result = runCli("codex", args);
  return result.ok
    ? { status: "configured" }
    : { status: "failed", detail: result.output };
}

function gooseConfigPath() {
  return path.join(os.homedir(), ".config", "goose", "config.yaml");
}

function registerGoose(opts) {
  const configPath = gooseConfigPath();
  let original = "";
  try {
    original = fs.readFileSync(configPath, "utf8");
  } catch {
    /* first-run: create the file */
  }
  let updated;
  try {
    updated = upsertVibewatchExtension(original, {
      envs: registrationEnv(opts),
    });
  } catch (err) {
    return { status: "failed", detail: err.message };
  }
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (original !== "") {
      fs.writeFileSync(`${configPath}.vibewatch-bak`, original);
    }
    // Atomic replace so a crash mid-write can't truncate the config.
    const tmpPath = `${configPath}.vibewatch-tmp`;
    fs.writeFileSync(tmpPath, updated);
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    return { status: "failed", detail: err.message };
  }
  return { status: "configured" };
}

function detectAndRegister(opts) {
  const wanted = opts.harnesses;
  const results = [];
  const include = (h) => !wanted || wanted.includes(h);
  const apply = (found, register) => {
    if (!found) return { status: "not found" };
    if (opts.dryRun) return { status: "would configure" };
    return register(opts);
  };

  if (include("claude")) {
    results.push({
      harness: "Claude Code",
      ...apply(findOnPath("claude") !== null, registerClaude),
    });
  }
  if (include("codex")) {
    results.push({
      harness: "Codex",
      ...apply(findOnPath("codex") !== null, registerCodex),
    });
  }
  if (include("goose")) {
    const goosePresent =
      findOnPath("goose") !== null || fs.existsSync(gooseConfigPath());
    results.push({
      harness: "Goose",
      ...apply(goosePresent, registerGoose),
    });
  }
  return results;
}

function printManualSnippet(opts) {
  const env = registrationEnv(opts);
  const server = { command: "vibewatch-mcp" };
  if (Object.keys(env).length > 0) server.env = env;
  process.stderr.write(
    "\nNo supported harness found on this machine. Add this to your MCP " +
      "client's config by hand:\n\n" +
      JSON.stringify({ mcpServers: { vibewatch: server } }, null, 2) +
      "\n"
  );
}

async function run(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`vibewatch-mcp: ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stderr.write(USAGE);
    return 0;
  }

  // Registrations reference the bare `vibewatch-mcp` command, so it must be
  // globally installed — an npx run resolves here but vanishes from PATH the
  // moment it exits.
  const selfPath = findOnPath("vibewatch-mcp");
  if (!selfPath || selfPath.includes("_npx")) {
    process.stderr.write(
      "vibewatch-mcp: install globally first so your agents can find the " +
        "bridge:\n\n  npm install -g vibewatch-mcp\n  vibewatch-mcp connect-buzz\n"
    );
    return 1;
  }

  if (opts.reset) {
    const removed = resetCachedAuth(opts.url);
    process.stderr.write(
      removed > 0
        ? "Cleared the cached sign-in — you'll pick an organization again in " +
            "the browser.\n"
        : "No cached sign-in to clear.\n"
    );
  }

  if (opts.key && !opts.key.startsWith("vw_mcp_")) {
    process.stderr.write(
      "vibewatch-mcp: that doesn't look like a Vibewatch MCP key (keys start " +
        "with vw_mcp_). Mint one in app.vibewatch.io → Settings → API Access.\n"
    );
    return 2;
  }

  process.stderr.write(
    opts.key
      ? "Checking your key against the Vibewatch MCP server...\n"
      : "Connecting to the Vibewatch MCP server...\n"
  );
  try {
    const { signedIn } = await verifyAuth(opts);
    process.stderr.write(
      signedIn
        ? "Signed in. Access approved and cached — your agents won't be " +
          "prompted again.\n"
        : opts.key
          ? "Key verified.\n"
          : "Already signed in — using the cached sign-in.\n"
    );
  } catch (err) {
    process.stderr.write(`vibewatch-mcp: ${err.message}\n`);
    return 1;
  }

  process.stderr.write("\nConfiguring your agent harnesses:\n");
  const results = detectAndRegister(opts);
  for (const r of results) {
    const mark =
      r.status === "configured" || r.status === "would configure"
        ? "✓"
        : r.status === "not found"
          ? "–"
          : "✗";
    process.stderr.write(
      `  ${mark} ${r.harness}: ${r.status}${r.detail ? ` (${r.detail})` : ""}\n`
    );
  }
  if (opts.dryRun) {
    process.stderr.write(
      "\nDry run — nothing was changed. Re-run without --dry-run to " +
        "configure.\n"
    );
    return 0;
  }
  const configured = results.filter((r) => r.status === "configured");
  const failed = results.filter((r) => r.status === "failed");
  if (configured.length === 0 && failed.length === 0) {
    printManualSnippet(opts);
  }

  if (configured.length > 0) {
    process.stderr.write(
      "\nDone. Restart your Buzz agents (Buzz → Agents) to pick up the " +
        "Vibewatch tools.\n\n" +
        "Note: this registers Vibewatch at user scope, so every " +
        configured.map((r) => r.harness).join(" and ") +
        " session on this machine can query it — the data is read-only " +
        "community sentiment for your organization. Remove it any time:\n"
    );
    for (const r of configured) {
      if (r.harness === "Claude Code") {
        process.stderr.write("  claude mcp remove --scope user vibewatch\n");
      } else if (r.harness === "Codex") {
        process.stderr.write("  codex mcp remove vibewatch\n");
      } else if (r.harness === "Goose") {
        process.stderr.write(
          "  remove the extensions.vibewatch entry from " +
            "~/.config/goose/config.yaml\n"
        );
      }
    }
  }
  return failed.length > 0 ? 1 : 0;
}

module.exports = {
  run,
  // Exported for tests.
  parseArgs,
  registrationEnv,
  findOnPath,
  resetCachedAuth,
  authCacheBase,
  detectAndRegister,
};
