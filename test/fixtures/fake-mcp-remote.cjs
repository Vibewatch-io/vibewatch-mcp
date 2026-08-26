"use strict";

// Fake mcp-remote for bridge tests: replays the stderr signatures named in
// VW_TEST_SCRIPT (comma-separated: prompt, wait, proxy-up, auth-fail) with a
// short delay between lines (the bridge's matcher is line-buffered and
// order-sensitive), then exits 0.
const lines = {
  // Two lines, like the real mcp-remote: the prompt sentence, then the URL
  // on its own line (the bridge's URL capture must not assume same-line).
  prompt:
    "Please authorize this client by visiting:\n" +
    "https://example.test/authorize?request_id=fixture&client_id=abc",
  // A prompt whose URL never arrives (reformatted output, unparseable URL) —
  // the bridge's fallback must still record a `wait` marker.
  "prompt-no-url": "Please authorize this client by visiting:",
  wait: "Authentication required. Waiting for authorization...",
  "proxy-up": "Proxy established successfully between local STDIO and remote",
  "auth-fail": "Error POSTing to endpoint (HTTP 401): Unauthorized",
};
const script = (process.env.VW_TEST_SCRIPT || "").split(",").filter(Boolean);
const lineDelayMs = Number(process.env.VW_TEST_LINE_DELAY_MS || "100");
// A typo'd key would otherwise emit the literal line "undefined" and fail
// the test on an unrelated assertion — abort loudly instead. "open" is a
// behavior key, not a line: it calls the real vendored `open` package, so
// the tests can prove the BRIDGE's spawn carries the suppression shim (a
// shim-only unit test would keep passing with the --require wiring deleted).
const validKeys = [...Object.keys(lines), "open"];
const unknown = script.filter((key) => !validKeys.includes(key));
if (unknown.length > 0) {
  process.stderr.write(
    `fake-mcp-remote: unknown VW_TEST_SCRIPT key(s) ${unknown.join(", ")} — ` +
      `valid keys: ${validKeys.join(", ")}\n`
  );
  process.exit(2);
}
const exitCode = Number(process.env.VW_TEST_EXIT || "0");
// VW_TEST_FRAGMENT=1 delivers each payload in small non-line-aligned writes,
// forcing the bridge's stderr splitter through partial prompt/URL chunks.
const emit = (text) => {
  if (process.env.VW_TEST_FRAGMENT === "1") {
    for (let j = 0; j < text.length; j += 7) {
      process.stderr.write(text.slice(j, j + 7));
    }
    return;
  }
  process.stderr.write(text);
};
let i = 0;
const tick = () => {
  if (i >= script.length) {
    process.exit(exitCode);
  }
  const key = script[i];
  i++;
  if (key === "proxy-up") {
    // The real mcp-remote persists tokens BEFORE printing the
    // proxy-established line; the bridge's proxy-up marker retirement is
    // conditional on exactly that (a marker with no newer tokens is a
    // NEWER phase's claim and must survive), so the fake must model it.
    const { serverHash } = require("../../lib/common.js");
    const base =
      process.env.MCP_REMOTE_CONFIG_DIR ||
      require("node:path").join(require("node:os").homedir(), ".mcp-auth");
    const url = process.env.VIBEWATCH_MCP_URL || "https://api.vibewatch.io/mcp/";
    const dir = require("node:path").join(base, "mcp-remote-0.0.0");
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(
      require("node:path").join(dir, `${serverHash(url)}_tokens.json`),
      "{}\n"
    );
  }
  if (key === "open") {
    import("open")
      .then(({ default: open }) => open("https://example.test/from-fake"))
      .catch((err) =>
        process.stderr.write(`fake-mcp-remote: open() failed: ${err}\n`)
      )
      .then(() => setTimeout(tick, lineDelayMs));
    return;
  }
  emit(`[${process.pid}] ${lines[key]}\n`);
  setTimeout(tick, lineDelayMs);
};
setTimeout(tick, lineDelayMs);
