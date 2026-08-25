"use strict";

// Fake mcp-remote for bridge tests: replays the stderr signatures named in
// VW_TEST_SCRIPT (comma-separated: prompt, wait, proxy-up, auth-fail) with a
// short delay between lines (the bridge's matcher is line-buffered and
// order-sensitive), then exits 0.
const lines = {
  prompt: "Please authorize this client by visiting: https://example.test/x",
  wait: "Authentication required. Waiting for authorization...",
  "proxy-up": "Proxy established successfully between local STDIO and remote",
  "auth-fail": "Error POSTing to endpoint (HTTP 401): Unauthorized",
};
const script = (process.env.VW_TEST_SCRIPT || "").split(",").filter(Boolean);
const exitCode = Number(process.env.VW_TEST_EXIT || "0");
let i = 0;
const tick = () => {
  if (i >= script.length) {
    process.exit(exitCode);
  }
  process.stderr.write(`[${process.pid}] ${lines[script[i]]}\n`);
  i++;
  setTimeout(tick, 100);
};
tick();
