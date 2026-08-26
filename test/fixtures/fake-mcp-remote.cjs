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
  wait: "Authentication required. Waiting for authorization...",
  "proxy-up": "Proxy established successfully between local STDIO and remote",
  "auth-fail": "Error POSTing to endpoint (HTTP 401): Unauthorized",
};
const script = (process.env.VW_TEST_SCRIPT || "").split(",").filter(Boolean);
const lineDelayMs = Number(process.env.VW_TEST_LINE_DELAY_MS || "100");
// A typo'd key would otherwise emit the literal line "undefined" and fail
// the test on an unrelated assertion — abort loudly instead.
const unknown = script.filter((key) => !(key in lines));
if (unknown.length > 0) {
  process.stderr.write(
    `fake-mcp-remote: unknown VW_TEST_SCRIPT key(s) ${unknown.join(", ")} — ` +
      `valid keys: ${Object.keys(lines).join(", ")}\n`
  );
  process.exit(2);
}
const exitCode = Number(process.env.VW_TEST_EXIT || "0");
let i = 0;
const tick = () => {
  if (i >= script.length) {
    process.exit(exitCode);
  }
  process.stderr.write(`[${process.pid}] ${lines[script[i]]}\n`);
  i++;
  setTimeout(tick, lineDelayMs);
};
setTimeout(tick, lineDelayMs);
