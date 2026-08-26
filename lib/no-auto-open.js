"use strict";

/**
 * `--require` preload for the bundled mcp-remote (issue #10): the pinned
 * mcp-remote 0.1.38 opens the browser itself on every auth phase
 * (redirectToAuthorization → the `open` package) with no flag or env to turn
 * that off. Under the bridge that auto-open is the tab storm: N live proxies
 * hitting 401 at once each open their own authorize tab via the takeover
 * cascade in mcp-remote's lock coordination. The bridge therefore spawns
 * mcp-remote with this shim, which neuters the platform-opener spawn, and
 * opens the sign-in tab itself — at most once machine-wide per auth phase
 * (see tryClaimAuthPrompt in lib/common.js).
 *
 * Active only when VIBEWATCH_MCP_SUPPRESS_BROWSER_OPEN=1, which only the
 * bridge sets on its child: direct mcp-remote use and connect-buzz (the
 * explicit interactive sign-in) keep their native auto-open.
 *
 * Interception point: the `open` package funnels every platform through one
 * childProcess.spawn(command, args) — darwin "open", win32 "powershell"
 * variants, linux "xdg-open" or its own bundled xdg-open script (an absolute
 * path, hence the substring check as well as the basename set). The pinned
 * mcp-remote spawns nothing else, so anything matching the opener filter is
 * a browser open. A matched spawn is replaced with a no-op node child
 * (process.execPath -e ""): a real ChildProcess that exits 0, preserving the
 * `open` package's success contract (it attaches error/close listeners and
 * unrefs), unlike a stub object would.
 *
 * VIBEWATCH_MCP_SUPPRESS_LOG (optional): a file path; each suppressed open
 * appends one JSON line {command, args}. Test seam and debugging aid.
 */

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.env.VIBEWATCH_MCP_SUPPRESS_BROWSER_OPEN === "1") {
  const OPENER_BASENAMES = new Set([
    "open",
    "xdg-open",
    "wslview",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "cmd",
    "cmd.exe",
    "explorer.exe",
  ]);

  const isOpenerCommand = (command) => {
    if (typeof command !== "string" || command === "") return false;
    const base = path.basename(command).toLowerCase();
    if (OPENER_BASENAMES.has(base)) return true;
    // The `open` package's bundled fallback is an absolute path ending in
    // xdg-open; basename covers it, but keep the substring check as belt
    // and braces against renamed wrappers (e.g. "xdg-open-wrapper").
    return command.toLowerCase().includes("xdg-open");
  };

  let noted = false;
  const realSpawn = childProcess.spawn;
  childProcess.spawn = function spawn(command, args, options) {
    // Node allows spawn(command, options) with no args array.
    const argList = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    if (!isOpenerCommand(command)) {
      return realSpawn.call(this, command, args, options);
    }
    if (!noted) {
      noted = true;
      try {
        process.stderr.write(
          "vibewatch-mcp: suppressed mcp-remote's browser auto-open " +
            "(the bridge manages sign-in tabs).\n"
        );
      } catch {
        /* stderr may be gone during teardown */
      }
    }
    const logPath = process.env.VIBEWATCH_MCP_SUPPRESS_LOG;
    if (logPath) {
      try {
        fs.appendFileSync(
          logPath,
          JSON.stringify({ command, args: argList }) + "\n"
        );
      } catch {
        /* the log is best-effort */
      }
    }
    // Preserve the caller's options (detached/stdio) so unref() and the
    // wait-mode close listener behave exactly as with a real opener.
    return realSpawn.call(this, process.execPath, ["-e", ""], opts);
  };
}
