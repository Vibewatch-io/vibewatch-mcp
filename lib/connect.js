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

const {
  DEFAULT_URL,
  AUTH_FAILURE_RE,
  AUTH_PROMPT_RE,
  PROXY_UP_RE,
  bridgeArgs,
  makeLineSplitter,
  killChild,
  resolveMcpRemoteBin,
} = require("./common.js");
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

// Registration values end up in harness CLI argv (and, on Windows, pass
// through cmd.exe when the CLIs are .cmd shims) — so every value that can
// reach a registration (key, URL, and on win32 the inherited
// MCP_REMOTE_CONFIG_DIR) is checked against a charset that can't be
// shell-interpreted anywhere. ARGV_UNSAFE_RE is the one shared denylist
// (no backslash — Windows paths need it); KEY_RE is the stricter allowlist
// form for keys; URLs additionally reject backslash (never legitimate
// there).
const KEY_RE = /^vw_mcp_[A-Za-z0-9._-]+$/;
const ARGV_UNSAFE_RE = /[\s&|^<>"'`;%]/;

function validateUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL`);
  }
  // Exactly mcp-remote's own allowlist — it rejects even IPv6 loopback over
  // plain http, so accepting more here would just fail later with a worse
  // message.
  const localhost = ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && localhost)
  ) {
    throw new Error(
      "the server URL must be https:// (http:// is only allowed for localhost)"
    );
  }
  if (ARGV_UNSAFE_RE.test(raw) || raw.includes("\\")) {
    throw new Error(
      "the server URL contains characters this setup can't pass through " +
        "safely (spaces, quotes, or shell metacharacters)"
    );
  }
}

function parseArgs(argv) {
  const opts = {
    key: process.env.VIBEWATCH_MCP_KEY || null,
    keySource: process.env.VIBEWATCH_MCP_KEY ? "env" : null,
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
      if (arg === "--key") {
        opts.key = value;
        opts.keySource = "flag";
      }
      if (arg === "--url") opts.url = value;
      if (arg === "--harness") {
        opts.harnesses = value
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean);
        if (opts.harnesses.length === 0) {
          throw new Error(
            `--harness needs at least one of: ${HARNESSES.join(", ")}`
          );
        }
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
  // Help must work even with a stale key or URL exported in the shell —
  // skip validation, run() prints usage and stops.
  if (opts.help) return opts;
  validateUrl(opts.url);
  if (opts.keySource === "flag" && !opts.key) {
    // An empty --key must not silently downgrade to browser sign-in — the
    // classic cause is an unset variable interpolated in CI.
    throw new Error(
      '--key got an empty value — if it came from a variable ("$KEY"), ' +
        "check that the variable is set."
    );
  }
  if (opts.key && !KEY_RE.test(opts.key)) {
    if (opts.keySource === "env" && !opts.key.startsWith("vw_mcp_")) {
      // A stale variable from another tool must not make the advertised
      // browser sign-in unreachable — drop it and continue in OAuth mode.
      // (Same prefix rule the bridge applies, so both stay consistent.)
      opts.key = null;
      opts.keySource = null;
      opts.envKeyIgnored = true;
    } else {
      throw new Error(
        opts.keySource === "env"
          ? "the VIBEWATCH_MCP_KEY in your environment looks corrupted. " +
            "Unset it (or export the key exactly as minted in " +
            "app.vibewatch.io → Settings → API Access) and re-run."
          : "that doesn't look like a Vibewatch MCP key (keys start with " +
            "vw_mcp_). Mint one in app.vibewatch.io → Settings → API Access."
      );
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
        // Directories carry the execute bit too — only files count.
        if (fs.statSync(candidate).isFile()) return candidate;
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
        fs.rmSync(path.join(dir, entry), { force: true, recursive: true });
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
      ...bridgeArgs({ keyMode: Boolean(key), serverUrl: url }),
    ];
    const child = spawn(process.execPath, args, {
      env: key ? { ...process.env, VIBEWATCH_MCP_KEY: key } : process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let settled = false;
    let sawAuthPrompt = false;
    // Ring of recent mcp-remote output, so an unrecognized failure (DNS,
    // TLS, a bad --url host) surfaces its actual cause instead of only
    // "exited early".
    const recentLines = [];
    // Settle only after the child is gone — run() exits the process right
    // after, and mcp-remote's non-exiting SIGINT handler would otherwise
    // leave an orphaned proxy behind on every failed (or finished) connect.
    let childClosed = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (childClosed) {
        fn(value);
        return;
      }
      const escalation = killChild(child);
      child.once("close", () => {
        clearTimeout(escalation);
        fn(value);
      });
    };
    const armTimer = (ms, message) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(reject, new Error(message)), ms);
    };
    // Two phases: a short window to reach the server, then — only once the
    // authorization prompt appears — the full consent window. A single
    // spawn-anchored timer would silently eat into the user's browser time
    // on a slow discovery round-trip.
    armTimer(
      30_000,
      "could not reach the Vibewatch MCP server. Check your network and " +
        "try again."
    );

    // NOTE: runBridge (bin/vibewatch-mcp.js) interprets the same mcp-remote
    // signatures with deliberately different policy — interactive messaging
    // and a long consent window here, headless timeouts and exit-code
    // semantics there. A change to mcp-remote's output lands in BOTH.
    const splitter = makeLineSplitter((rawLine) => {
      const line = rawLine.trim();
      if (line !== "") {
        recentLines.push(line);
        if (recentLines.length > 6) recentLines.shift();
      }
      {
        if (settled) {
          /* a decision was already made; ignore trailing output */
        } else if (/Authentication required/.test(line) && !sawAuthPrompt) {
          if (key) {
            // In key mode, any auth-required line means the server rejected
            // the key — including the shared-auth path, which never prints
            // the authorize-URL prompt the later branch relies on.
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
          // This line without our own authorize-URL prompt means another
          // process holds the sign-in lock. The pinned mcp-remote's
          // secondary path may not complete even after that sign-in
          // succeeds, so give it a bounded window and a message that names
          // the conflict rather than the network.
          armTimer(
            60_000,
            "another Vibewatch sign-in is in progress in a different " +
              "process. Finish it in the browser (or close that process), " +
              "then re-run `vibewatch-mcp connect-buzz`."
          );
        } else if (AUTH_PROMPT_RE.test(line)) {
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
          armTimer(
            AUTH_WAIT_MS,
            "timed out waiting for the browser sign-in. Re-run " +
              "`vibewatch-mcp connect-buzz` to try again."
          );
          process.stderr.write(
            "\nOpening your browser to sign in to Vibewatch — approve access " +
              "in the tab that opens.\n"
          );
        } else if (sawAuthPrompt && /^https?:\/\//.test(line)) {
          process.stderr.write(`If no tab opened, visit:\n  ${line}\n\n`);
        } else if (PROXY_UP_RE.test(line)) {
          finish(resolve, { signedIn: sawAuthPrompt });
        } else if (AUTH_FAILURE_RE.test(line)) {
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
    child.stderr.on("data", (chunk) => splitter.push(chunk));
    child.on("error", (err) => {
      // Spawn failure: there is no process, so no close event — settle now.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to start mcp-remote: ${err.message}`));
    });
    // `close`, not `exit`: the specific failure line (a rejected
    // registration, an invalid-scope error) often drains from the stderr
    // pipe after exit, and the splitter must get to diagnose it first.
    child.on("close", (code) => {
      childClosed = true;
      splitter.flush();
      if (!settled) {
        const tail =
          recentLines.length > 0
            ? `\n\nLast output from the connection check:\n  ${recentLines.join("\n  ")}`
            : "";
        finish(
          reject,
          new Error(
            `the connection check exited early (code ${code}). Re-run with ` +
              "--help for options, or set VIBEWATCH_MCP_KEY to use a key " +
              `instead.${tail}`
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
  // The key rides in the CLI's argv, and argument-parser errors routinely
  // echo the offending invocation — redact before anything gets printed.
  // spawnSync failures (ETIMEDOUT, EACCES) produce no stdio at all, so the
  // error itself is the only diagnostic.
  const output = [
    `${result.stdout || ""}${result.stderr || ""}`.trim(),
    result.error ? result.error.message : "",
  ]
    .filter(Boolean)
    .join(" — ")
    .replace(/vw_mcp_[A-Za-z0-9._-]+/g, "vw_mcp_…");
  return { ok: result.status === 0, output };
}

/** Env entries every registration shares: key and/or URL when non-default. */
function registrationEnv({ key, url }) {
  const env = {};
  if (key) env.VIBEWATCH_MCP_KEY = key;
  if (url !== DEFAULT_URL) env.VIBEWATCH_MCP_URL = url;
  // A custom token-cache location must reach the harness-spawned bridge too,
  // or it looks signed-out and restarts OAuth.
  if (!key && process.env.MCP_REMOTE_CONFIG_DIR) {
    env.MCP_REMOTE_CONFIG_DIR = process.env.MCP_REMOTE_CONFIG_DIR;
  }
  return env;
}

// The registered command. On POSIX, the resolved absolute path:
// GUI-launched harnesses (Buzz or Goose Desktop opened from Finder) inherit
// a minimal PATH that excludes homebrew/nvm bin dirs, so a bare
// `vibewatch-mcp` can fail to resolve exactly where it matters. On Windows
// it depends on how the value travels: values bound for the harness CLIs
// ride through cmd.exe (forShell), where an absolute path under a username
// with spaces can't be quoted safely, and GUI apps get the full registry
// PATH anyway — bare name. Values written straight into config files
// (goose YAML, the manual snippet) involve no shell, and Windows spawn
// does not resolve a bare name to the npm .cmd shim — absolute path.
function bridgeCommand(opts, { forShell = false } = {}) {
  if (process.platform === "win32" && forShell) return "vibewatch-mcp";
  return opts.selfPath || "vibewatch-mcp";
}

function registerClaude(opts) {
  const env = registrationEnv(opts);
  const args = ["mcp", "add", "--scope", "user", "vibewatch"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push("--", bridgeCommand(opts, { forShell: true }));
  // Add first — `claude mcp add` refuses to replace an existing entry, so
  // remove only after a name collision. (If the retried add then fails, the
  // old entry is already gone — but that add just parsed successfully, so a
  // second failure means the CLI itself is broken and a restore through it
  // would fail the same way.) User scope only — local/project entries are
  // not ours to touch.
  let result = runCli("claude", args);
  if (!result.ok && /already exists/i.test(result.output)) {
    runCli("claude", ["mcp", "remove", "--scope", "user", "vibewatch"]);
    result = runCli("claude", args);
  }
  return result.ok
    ? { status: "configured" }
    : { status: "failed", detail: result.output };
}

function registerCodex(opts) {
  const env = registrationEnv(opts);
  // `codex mcp add` replaces an existing entry in place — no remove needed.
  const args = ["mcp", "add", "vibewatch"];
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  args.push("--", bridgeCommand(opts, { forShell: true }));
  const result = runCli("codex", args);
  return result.ok
    ? { status: "configured" }
    : { status: "failed", detail: result.output };
}

function gooseConfigPath() {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Block", "goose", "config", "config.yaml");
  }
  return path.join(os.homedir(), ".config", "goose", "config.yaml");
}

function registerGoose(opts) {
  // Resolve symlinks (dotfiles managers commonly link this file) so the
  // atomic rename below replaces the target, not the link.
  let configPath = gooseConfigPath();
  let original = "";
  try {
    original = fs.readFileSync(configPath, "utf8");
    configPath = fs.realpathSync(configPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      // Anything but a missing file (EACCES, EIO, …) must not fall through
      // to the create path — that would replace a config we couldn't read.
      return { status: "failed", detail: err.message };
    }
  }
  let updated;
  try {
    updated = upsertVibewatchExtension(original, {
      envs: registrationEnv(opts),
      cmd: bridgeCommand(opts),
    });
  } catch (err) {
    return { status: "failed", detail: err.message };
  }
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Owner-only mode on everything we write: in key mode the config and
    // backup carry the key, and Goose configs often hold other provider
    // credentials. rm first — writeFileSync's mode only applies on creation.
    if (original !== "") {
      const bakPath = `${configPath}.vibewatch-bak`;
      fs.rmSync(bakPath, { force: true });
      fs.writeFileSync(bakPath, original, { mode: 0o600 });
    }
    // Atomic replace so a crash mid-write can't truncate the config.
    const tmpPath = `${configPath}.vibewatch-tmp`;
    fs.rmSync(tmpPath, { force: true });
    fs.writeFileSync(tmpPath, updated, { mode: 0o600 });
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
  const env = { ...registrationEnv(opts) };
  // Keep the key itself out of the output — connect-buzz logs end up in CI
  // captures, and in env-sourced key mode the user never typed it here.
  if (env.VIBEWATCH_MCP_KEY) env.VIBEWATCH_MCP_KEY = "<your vw_mcp_ key>";
  // The absolute path matters most here: this snippet targets GUI clients,
  // exactly the processes that inherit a minimal PATH.
  const server = { command: bridgeCommand(opts) };
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

  // Registrations reference the bridge binary, so it must be globally
  // installed. Any node_modules path — an npx cache or a project's .bin —
  // resolves here but won't exist (or be on PATH) when a harness spawns the
  // bridge later. (Global npm bins are symlinks placed outside node_modules,
  // and findOnPath returns the PATH entry unresolved.)
  const selfPath = findOnPath("vibewatch-mcp");
  if (!selfPath || selfPath.split(path.sep).includes("node_modules")) {
    process.stderr.write(
      "vibewatch-mcp: install globally first so your agents can find the " +
        "bridge:\n\n  npm install -g vibewatch-mcp\n  vibewatch-mcp connect-buzz\n"
    );
    return 1;
  }
  // Registrations use the absolute path — GUI-launched harnesses inherit a
  // minimal PATH that may not include the npm bin dir.
  opts.selfPath = selfPath;
  // The sign-in below seeds the RUNNING build's version-keyed token cache;
  // a different install on PATH bundles its own mcp-remote and may read a
  // different cache dir — agents would be re-prompted despite our success
  // message. POSIX only: npm's Windows launcher is a .cmd shim, not a
  // symlink, so the realpath comparison would always report a mismatch
  // there (and Windows registers the bare name anyway).
  if (process.platform !== "win32") {
    const runningBin = fs.realpathSync(
      path.resolve(__dirname, "..", "bin", "vibewatch-mcp.js")
    );
    let registeredTarget = selfPath;
    try {
      registeredTarget = fs.realpathSync(selfPath);
    } catch {
      /* keep the unresolved path */
    }
    if (registeredTarget !== runningBin) {
      process.stderr.write(
        `Note: the vibewatch-mcp being registered (${selfPath}) is a ` +
          "different install than the one running this command. If your " +
          "agents still ask to sign in, re-run connect-buzz with that " +
          "install: vibewatch-mcp connect-buzz\n"
      );
    }
  }

  // On Windows the harness CLIs run through cmd.exe, which offers no safe
  // way to pass a path containing spaces or metacharacters as one argument.
  // Key mode never registers the cache dir (registrationEnv omits it), so
  // only OAuth mode needs the guard.
  const inheritedCacheDir = process.env.MCP_REMOTE_CONFIG_DIR;
  if (
    inheritedCacheDir &&
    !opts.key &&
    process.platform === "win32" &&
    ARGV_UNSAFE_RE.test(inheritedCacheDir)
  ) {
    process.stderr.write(
      "vibewatch-mcp: MCP_REMOTE_CONFIG_DIR contains spaces or special " +
        "characters, which can't be passed to the harness CLIs safely on " +
        "Windows. Point it at a simpler path and re-run.\n"
    );
    return 2;
  }

  if (opts.reset) {
    if (opts.dryRun) {
      process.stderr.write("Dry run — leaving the cached sign-in in place.\n");
    } else {
      const removed = resetCachedAuth(opts.url);
      process.stderr.write(
        removed > 0
          ? "Cleared the cached sign-in — you'll pick an organization again " +
              "in the browser.\n"
          : "No cached sign-in to clear.\n"
      );
    }
  }

  if (opts.envKeyIgnored) {
    process.stderr.write(
      "Ignoring the VIBEWATCH_MCP_KEY in your environment — it doesn't look " +
        "like a Vibewatch key (they start with vw_mcp_). Continuing with " +
        "browser sign-in; unset the variable to silence this.\n"
    );
  }
  if (opts.keySource === "env") {
    process.stderr.write(
      "Found VIBEWATCH_MCP_KEY in your environment — using key mode, which " +
        "stores the key in each harness config. Unset it and re-run for " +
        "browser sign-in instead.\n"
    );
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
  // None-found handling runs before the dry-run return so a --dry-run
  // preflight can't report green on a machine where the real run would
  // configure nothing.
  const detected = results.filter((r) => r.status !== "not found");
  if (detected.length === 0) {
    if (opts.harnesses) {
      // The user explicitly asked for these — configuring nothing is a
      // failure, not a fallback.
      process.stderr.write(
        `\nNone of the requested harnesses (${opts.harnesses.join(", ")}) ` +
          "were found on this machine.\n"
      );
      return 1;
    }
    // No harness was configured either way — wrapping scripts must not read
    // the snippet fallback as a completed setup.
    printManualSnippet(opts);
    return 1;
  }
  if (opts.dryRun) {
    process.stderr.write(
      "\nDry run — no harness config was changed. (The sign-in check was " +
        "real, so its cache is warm.) Re-run without --dry-run to " +
        "configure.\n"
    );
    return 0;
  }
  const configured = results.filter((r) => r.status === "configured");
  const failed = results.filter((r) => r.status === "failed");

  if (configured.length > 0) {
    process.stderr.write(
      "\nDone. Restart your Buzz agents (Buzz → Agents) to pick up the " +
        "Vibewatch tools.\n\n" +
        "Note: this registers Vibewatch at user scope, so every " +
        configured.map((r) => r.harness).join(" and ") +
        " session on this machine can query it — the data is read-only " +
        "community sentiment for your organization." +
        (opts.key
          ? " Your key was stored in each of those configs."
          : "") +
        " Remove it any time:\n"
    );
    for (const r of configured) {
      if (r.harness === "Claude Code") {
        process.stderr.write("  claude mcp remove --scope user vibewatch\n");
      } else if (r.harness === "Codex") {
        process.stderr.write("  codex mcp remove vibewatch\n");
      } else if (r.harness === "Goose") {
        process.stderr.write(
          "  remove the extensions.vibewatch entry from " +
            `${gooseConfigPath()}\n`
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
