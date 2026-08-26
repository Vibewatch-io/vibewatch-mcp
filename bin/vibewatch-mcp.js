#!/usr/bin/env node
"use strict";

/**
 * vibewatch-mcp — stdio bridge to the Vibewatch MCP server.
 *
 * Wraps mcp-remote so any stdio MCP client (Buzz agents, Claude Code, Goose,
 * Codex) can reach https://api.vibewatch.io/mcp/.
 *
 * Two ways to authenticate:
 *   - OAuth (default): run `vibewatch-mcp connect-buzz` once — it signs you in
 *     via the browser and caches tokens that the bridge reuses headlessly.
 *   - Key: set VIBEWATCH_MCP_KEY to an org-scoped key (starts with vw_mcp_),
 *     minted in app.vibewatch.io → Settings → API Access.
 *
 * Optional env:  VIBEWATCH_MCP_URL  — override the server URL (self-hosted /
 *                staging).
 *
 * The bridge never puts the key on a process argument list — mcp-remote gets
 * the literal string "Authorization: Bearer ${VIBEWATCH_MCP_KEY}" and expands
 * the env var itself. (`connect-buzz --key` is different: the harness CLIs it
 * drives only accept env values as arguments, so the key is briefly visible
 * in their argv — documented in the README.)
 */

const { spawn } = require("node:child_process");

const {
  DEFAULT_URL,
  AUTH_FAILURE_RE,
  AUTH_PROMPT_RE,
  AUTH_WAIT_RE,
  PROXY_UP_RE,
  // How long the bridge waits for a browser sign-in after mcp-remote prints
  // the authorization prompt. mcp-remote itself never times this wait out
  // (its --auth-timeout only bounds a secondary-instance long poll), so
  // without this timer a headless host with no cached sign-in would hang
  // forever. Long enough for a human to approve on an interactive first
  // connect. Lives in lib/common.js so the spawn-claim wait derives from it.
  BRIDGE_AUTH_WAIT_MS,
  CLAIM_PREAUTH_ABORT_MS,
  acquireSpawnSlot,
  bridgeArgs,
  demoteAuthMarkerToWait,
  extractAuthUrl,
  makeLineSplitter,
  noAutoOpenShimPath,
  oauthSpawnGate,
  openBrowser,
  recordWaitMarker,
  resolveMcpRemoteBin,
  spawnClaimEnabled,
  tryClaimAuthPrompt,
  tryRetireAuthMarker,
  fail,
} = require("../lib/common.js");

// How long a suppressed spawn (see oauthSpawnGate) lingers before exiting
// non-zero. The marker is the real cap on browser tabs; this only keeps a
// host with unlimited immediate respawns from hot-spinning on the exit.
const BRIDGE_SUPPRESSED_EXIT_HOLD_MS = 2_000;

function writeAuthGuidance(keyMode) {
  process.stderr.write(
    keyMode
      ? "\nvibewatch-mcp: the server rejected this VIBEWATCH_MCP_KEY. " +
          "Check the key (it should start with vw_mcp_), or mint a new " +
          "one in app.vibewatch.io → Settings → API Access.\n"
      : "\nvibewatch-mcp: not signed in (or the sign-in expired). " +
          "Run `vibewatch-mcp connect-buzz` to sign in via the browser, " +
          "or set VIBEWATCH_MCP_KEY to an org key from " +
          "app.vibewatch.io → Settings → API Access.\n"
  );
}

function exitSuppressed(message, { guidance = true } = {}) {
  process.stderr.write(message);
  // The claim-timeout path skips the sign-in guidance: pointing at
  // connect-buzz there sends the user into the same held claim.
  if (guidance) writeAuthGuidance(false);
  process.exitCode = 1;
  // Keep the event loop alive briefly so the exit isn't a hot spin for a
  // host with unlimited immediate respawns.
  setTimeout(() => {}, BRIDGE_SUPPRESSED_EXIT_HOLD_MS);
}

async function runBridge() {
  // Mirror connect-buzz's env-key leniency: a stale non-Vibewatch value
  // (keys always start with vw_mcp_) must not flip a configured OAuth
  // bridge into key mode with a garbage bearer token.
  let keyMode = Boolean(process.env.VIBEWATCH_MCP_KEY);
  if (keyMode && !process.env.VIBEWATCH_MCP_KEY.startsWith("vw_mcp_")) {
    process.stderr.write(
      "vibewatch-mcp: ignoring VIBEWATCH_MCP_KEY (doesn't look like a " +
        "Vibewatch key — they start with vw_mcp_); using the cached " +
        "sign-in.\n"
    );
    keyMode = false;
  }
  const serverUrl = process.env.VIBEWATCH_MCP_URL || DEFAULT_URL;

  // One browser prompt per missing sign-in (issue #4): if a previous bridge
  // already opened the authorize tab and nobody completed it, don't spawn
  // mcp-remote again (each spawn opens another tab) — point at connect-buzz
  // and exit. A sign-in that landed since (tokens newer than the marker)
  // lifts the suppression.
  if (!keyMode) {
    const gate = oauthSpawnGate(serverUrl);
    if (gate === "satisfied") {
      // Retire (rename-and-verify), never blind-clear: between the gate read
      // and this line a NEWER auth phase may have claimed the marker path,
      // and deleting its fresh `opened` claim would let a second tab open
      // (review P1). Retirement restores a live foreign claim it steals.
      tryRetireAuthMarker(serverUrl);
    } else if (gate === "suppress") {
      exitSuppressed(
        "vibewatch-mcp: a Vibewatch sign-in tab was already opened and " +
          "never completed — not opening another one.\n"
      );
      return;
    }
  }

  // Single-owner spawning where mcp-remote has no lock of its own (issue
  // #6, Windows): concurrently launched bridges wait for the owner instead
  // of racing it to a second browser tab.
  let claim = null;
  // Rebound after the child spawns: a claim lost to takeover (this process
  // was suspended past staleness) must kill the child before it can reach
  // the auth phase beside the successor and open a second tab.
  let onClaimLost = () => {};
  if (!keyMode && spawnClaimEnabled()) {
    const slot = await acquireSpawnSlot(serverUrl, {
      onLost: () => onClaimLost(),
    });
    if (slot.status === "acquired") {
      claim = slot;
    } else if (slot.status === "satisfied") {
      tryRetireAuthMarker(serverUrl);
    } else if (slot.status === "suppress") {
      exitSuppressed(
        "vibewatch-mcp: another vibewatch-mcp process opened the sign-in " +
          "tab and it was never completed — not opening another one.\n"
      );
      return;
    } else if (slot.status === "timeout") {
      // Reachable both mid-sign-in and when the owner stalls pre-connect
      // (unreachable server, retry loop) — name both, don't assume a tab.
      exitSuppressed(
        "vibewatch-mcp: another vibewatch-mcp process is still connecting " +
          "or signing in — finish its sign-in if a browser tab is open, " +
          "or close that process and retry.\n",
        { guidance: false }
      );
      return;
    } else {
      // "unclaimed": claim storage is unusable — proceed (the marker still
      // caps sequential respawns) but say the concurrency guard is off.
      process.stderr.write(
        `vibewatch-mcp: could not record the sign-in claim (${slot.reason}) ` +
          "— concurrent sessions may each open a sign-in tab.\n"
      );
    }
  }

  let mcpRemoteBin;
  try {
    mcpRemoteBin = resolveMcpRemoteBin();
  } catch (err) {
    if (claim) claim.release();
    // Nothing has been written yet, so fail()'s inline exit is safe here.
    fail(err.message);
  }

  // Extra args (e.g. --debug) pass straight through to mcp-remote.
  const passthrough = process.argv.slice(2);

  // --require shim + env flag: mcp-remote must never open a browser itself
  // (issue #10 — the takeover cascade in its auth coordination opens a tab
  // per live proxy on a mass 401). The bridge opens the tab instead, gated
  // machine-wide below. Set for key mode too: it never prompts, and one
  // invariant ("mcp-remote under the bridge never opens a browser") is
  // simpler than two.
  const child = spawn(
    process.execPath,
    [
      "--require",
      noAutoOpenShimPath(),
      mcpRemoteBin,
      ...bridgeArgs({ keyMode, serverUrl, passthrough }),
    ],
    {
      stdio: ["inherit", "inherit", "pipe"],
      env: { ...process.env, VIBEWATCH_MCP_SUPPRESS_BROWSER_OPEN: "1" },
    }
  );

  // Forward stderr while watching for the signatures of failed
  // authentication, so the exit message can name the actual fix. Matching is
  // line-buffered — a signature can span two stream chunks otherwise.
  let sawAuthFailure = false;
  // Set only when WE kill the child for an auth reason. The child may handle
  // that SIGINT and exit 0, so the child's exit result alone can't be
  // trusted to report the failure.
  let authAbort = false;
  let forwardedSignal = null;
  let authTimer = null;
  let killTimer = null;

  // mcp-remote's auth coordinator installs a SIGINT handler that cleans up
  // and never exits (and it ignores SIGTERM outright), so every kill is one
  // signal plus a SIGKILL backstop.
  const endChild = (signal) => {
    child.kill(signal);
    if (!killTimer) {
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      killTimer.unref();
    }
  };

  // NOTE: verifyAuth (lib/connect.js) interprets the same mcp-remote
  // signatures with deliberately different policy — interactive messaging
  // there, headless timeouts and exit codes here. A change to mcp-remote's
  // output lands in BOTH.
  let connected = false;
  // A claim owner stalled with neither an auth line nor a connected proxy
  // (see CLAIM_PREAUTH_ABORT_MS) EXITS — child killed, claim released on
  // close — so exactly one session at a time retries against a slow or
  // unreachable server. It must not merely release and keep running: its
  // still-attached mcp-remote would prompt unserialized later, and every
  // accumulated bridge would open a tab the moment the server recovered.
  // Cleared when an auth phase starts (the owner then legitimately holds
  // the claim for the sign-in) and on proxy-up.
  let claimStallAbort = false;
  let claimLostAbort = false;
  let claimPreauthTimer = null;
  if (claim) {
    claimPreauthTimer = setTimeout(() => {
      claimStallAbort = true;
      endChild("SIGINT");
    }, CLAIM_PREAUTH_ABORT_MS);
    claimPreauthTimer.unref();
    onClaimLost = () => {
      claimLostAbort = true;
      endChild("SIGINT");
    };
  }
  const clearClaimPreauthTimer = () => {
    if (claimPreauthTimer) {
      clearTimeout(claimPreauthTimer);
      claimPreauthTimer = null;
    }
  };
  // One marker write per auth phase; reset on proxy-up so a mid-session
  // re-auth records its own prompt.
  let markerRecorded = false;
  // Armed by the prompt line: the authorize URL follows (real mcp-remote
  // prints it on the next line; the same line also works). Reset on
  // proxy-up along with the phase latch.
  let awaitingAuthUrl = false;
  // How long a prompt may await its URL before the fallback records a
  // `wait` marker anyway (see the isPrompt branch below). Well past any
  // stream-buffering gap, well short of BRIDGE_AUTH_WAIT_MS.
  const AUTH_URL_FALLBACK_MS = 5_000;
  let authUrlFallbackTimer = null;
  const clearAuthUrlFallbackTimer = () => {
    if (authUrlFallbackTimer) {
      clearTimeout(authUrlFallbackTimer);
      authUrlFallbackTimer = null;
    }
  };
  const recordWaitAuthMarker = () => {
    if (keyMode || markerRecorded) return;
    markerRecorded = true;
    try {
      recordWaitMarker(serverUrl);
    } catch (err) {
      // Named diagnostic, not a silent fallback: with no marker on disk,
      // every host respawn will prompt again (the pre-#4 tab storm).
      process.stderr.write(
        "vibewatch-mcp: could not record the sign-in prompt " +
          `(${err.message}) — repeated host restarts may re-open the ` +
          "browser tab until you run `vibewatch-mcp connect-buzz`.\n"
      );
    }
  };
  // The single machine-wide tab open per auth phase (issue #10): the claim
  // on the pending-auth marker decides which session opens; everyone else
  // points at the already-open tab. mcp-remote's own open is suppressed by
  // the --require shim, so this is the only place a tab can come from.
  //
  // Latched per phase: mcp-remote with --debug emits every log line twice
  // (log() → console.error + debugLog → console.error), so the prompt block
  // repeats — re-entering the claim would hit our OWN fresh `opened` marker
  // and print a false "another session" warning right after "opened the
  // sign-in page". Reset on proxy-up with the other phase latches.
  let authUrlHandled = false;
  const handleAuthPromptUrl = (url) => {
    if (authUrlHandled) return;
    authUrlHandled = true;
    markerRecorded = true; // the claim (ours or a foreign one) covers the phase
    const promptClaim = tryClaimAuthPrompt(serverUrl);
    if (!promptClaim.claimed) {
      process.stderr.write(
        "vibewatch-mcp: a Vibewatch sign-in tab is already open from " +
          "another session — complete it there (or run " +
          "`vibewatch-mcp connect-buzz`); not opening another.\n"
      );
      return;
    }
    if (promptClaim.degraded) {
      process.stderr.write(
        "vibewatch-mcp: could not record the sign-in prompt " +
          `(${promptClaim.degraded}) — concurrent sessions may each open a ` +
          "browser tab until you run `vibewatch-mcp connect-buzz`.\n"
      );
    }
    openBrowser(url).then((opened) => {
      if (!opened) {
        // The `opened` marker just claimed would otherwise suppress every
        // session for the full TTL with NO tab behind it (review P2) —
        // demote it to `wait` so another session's prompt can claim and
        // try its own opener, while host respawns stay suppressed. The
        // openedAt handshake makes the demotion a no-op if this phase's
        // marker is no longer the one on disk (degraded claims carry no
        // openedAt and skip it).
        demoteAuthMarkerToWait(serverUrl, promptClaim.openedAt);
      }
      process.stderr.write(
        opened
          ? "vibewatch-mcp: opened the Vibewatch sign-in page in your " +
              "browser — approve it there.\n"
          : "vibewatch-mcp: could not open a browser — copy the " +
              "authorization URL above into one.\n"
      );
    });
  };
  const splitter = makeLineSplitter((line) => {
    // Failure signatures only count before the proxy is up — a transient
    // 401 around a token refresh must not turn a later unrelated exit into
    // auth guidance.
    if (!connected && AUTH_FAILURE_RE.test(line)) {
      sawAuthFailure = true;
    }
    // The prompt marks an auth phase — initial sign-in or a mid-session
    // re-auth (revoked key, failed refresh). A successful re-auth re-prints
    // the proxy-established line ("Recursively reconnecting" path), so the
    // timer armed here is cleared when the session actually recovers.
    // AUTH_WAIT_RE covers the shared-auth path, whose lines never include
    // the authorize-URL prompt — without it, the loser of a sign-in
    // lockfile race would hold the client's stdio session forever.
    const isPrompt = AUTH_PROMPT_RE.test(line);
    if (isPrompt || AUTH_WAIT_RE.test(line)) {
      connected = false;
      clearClaimPreauthTimer();
      if (isPrompt) {
        // The prompt path records its marker through the tab-open claim in
        // handleAuthPromptUrl — writing one here first would make the
        // claimant lose its own wx race. But if no URL ever gets extracted
        // (mcp-remote reformats the prompt, an unparseable URL), NOTHING
        // would be recorded and — with auto-open suppressed — no tab opens
        // either, so every host respawn would re-run this dead phase with
        // no issue-#4 suppression (review P2). A short fallback records the
        // `wait` marker if the URL hasn't arrived; cleared on capture,
        // proxy-up, and close.
        awaitingAuthUrl = true;
        if (!keyMode && !authUrlFallbackTimer) {
          authUrlFallbackTimer = setTimeout(() => {
            if (awaitingAuthUrl) recordWaitAuthMarker();
          }, AUTH_URL_FALLBACK_MS);
          authUrlFallbackTimer.unref();
        }
      } else {
        recordWaitAuthMarker();
      }
      if (keyMode) {
        // A rejected key surfaces as a silent 401 that drops mcp-remote into
        // its interactive OAuth fallback — never right for a key user. Bail
        // out instead of hanging on a browser prompt.
        authAbort = true;
        endChild("SIGINT");
      } else if (!authTimer) {
        authTimer = setTimeout(() => {
          authAbort = true;
          endChild("SIGINT");
        }, BRIDGE_AUTH_WAIT_MS);
      }
    }
    if (awaitingAuthUrl && !keyMode) {
      const url = extractAuthUrl(line);
      if (url) {
        awaitingAuthUrl = false;
        clearAuthUrlFallbackTimer();
        handleAuthPromptUrl(url);
      }
    }
    if (PROXY_UP_RE.test(line)) {
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      connected = true;
      sawAuthFailure = false;
      // The auth phase (if any) completed — lift the one-prompt cap
      // (including a leftover expired marker file) and re-arm for a
      // possible mid-session re-auth. The spawn claim is released here
      // too: once connected this process holds no browser-tab risk, and
      // waiting siblings may proceed.
      if (!keyMode) {
        markerRecorded = false;
        awaitingAuthUrl = false;
        authUrlHandled = false;
        clearAuthUrlFallbackTimer();
        clearClaimPreauthTimer();
        // Retire, never blind-clear: this bridge's phase just completed
        // (tokens landed, so its marker reads satisfied), but a NEWER
        // phase's fresh `opened` claim on the same path must survive
        // (review P1).
        tryRetireAuthMarker(serverUrl);
        if (claim) claim.release();
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    splitter.push(chunk);
  });

  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of forwardedSignals) {
    process.on(signal, () => {
      forwardedSignal = signal;
      // endChild's SIGKILL backstop covers mcp-remote ignoring SIGTERM,
      // which would otherwise orphan both processes on a harness stop.
      endChild(signal);
    });
  }

  // `close`, not `exit`: it fires after the stderr pipe drains, so trailing
  // authentication output still reaches the matcher. Exit via exitCode, not
  // process.exit(), so our own piped stderr drains before termination.
  child.on("close", (code, signal) => {
    splitter.flush();
    if (claim) claim.release();
    clearClaimPreauthTimer();
    // Deliberately BEFORE clearing the fallback: a child that died with a
    // prompt still awaiting its URL should leave the `wait` marker the
    // fallback exists for — flush() above ran the splitter one last time,
    // and the timer (unref'd) will never fire post-exit, so record now.
    if (awaitingAuthUrl && !keyMode) recordWaitAuthMarker();
    clearAuthUrlFallbackTimer();
    if (authTimer) clearTimeout(authTimer);
    if (killTimer) clearTimeout(killTimer);
    if (claimStallAbort) {
      // We ended the child ourselves; its exit result must not report
      // success. A 401 seen before the stall means the hang is an auth
      // retry, not the network — keep the sign-in guidance for that case.
      process.stderr.write(
        "vibewatch-mcp: could not reach the Vibewatch MCP server within " +
          `${CLAIM_PREAUTH_ABORT_MS / 1000}s — check your network; your ` +
          "MCP client (or another waiting session) may retry.\n"
      );
      if (sawAuthFailure) writeAuthGuidance(keyMode);
      process.exitCode = 1;
      return;
    }
    if (claimLostAbort) {
      // This process was suspended long enough for another session to take
      // over its claim; the successor owns the sign-in now.
      process.stderr.write(
        "vibewatch-mcp: another vibewatch-mcp session took over the " +
          "sign-in after this one stalled — exiting; it will complete " +
          "the connection.\n"
      );
      process.exitCode = 1;
      return;
    }
    if (authAbort) {
      // We ended the session over auth; the child's own exit code (often 0,
      // from its SIGINT handler) must not report success.
      writeAuthGuidance(keyMode);
      process.exitCode = 1;
      return;
    }
    if (forwardedSignal) {
      // The user (or supervisor) stopped us — re-raise with the default
      // disposition restored so the signal terminates the process normally,
      // whatever stderr happened to contain.
      for (const s of forwardedSignals) process.removeAllListeners(s);
      process.kill(process.pid, forwardedSignal);
      return;
    }
    if (code !== 0 && sawAuthFailure) {
      writeAuthGuidance(keyMode);
    }
    process.exitCode = signal ? 1 : code === null ? 1 : code;
  });

  child.on("error", (err) => {
    if (claim) claim.release();
    fail(`failed to start mcp-remote: ${err.message}`);
  });
}

const subcommand = process.argv[2];
if (subcommand === "connect-buzz" || subcommand === "connect") {
  require("../lib/connect.js")
    .run(process.argv.slice(3))
    .then((code) => {
      // exitCode, not process.exit(): a piped stderr must drain first.
      process.exitCode = code;
    })
    .catch((err) => {
      // Not fail() — its inline exit would discard run()'s still-buffered
      // progress output on a piped stderr.
      process.stderr.write(`vibewatch-mcp: ${err.message}\n`);
      process.exitCode = 1;
    });
} else {
  runBridge().catch((err) => {
    // Not fail() — piped stderr output already written must drain first.
    process.stderr.write(`vibewatch-mcp: ${err.message}\n`);
    process.exitCode = 1;
  });
}
