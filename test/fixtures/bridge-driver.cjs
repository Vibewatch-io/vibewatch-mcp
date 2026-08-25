"use strict";

// Test driver: runs the real bridge (bin/vibewatch-mcp.js) with
// resolveMcpRemoteBin patched to return a fake mcp-remote script, so the
// auth-signature handling can be exercised without the network. Works
// because the bin destructures lib/common.js's export object at require
// time — patching the object first is enough.
// node --test discovers every file under test/ — a bare run of this driver
// (no fake configured) is the runner, not a bridge test; exit as a no-op.
if (!process.env.VW_TEST_FAKE_MCP_REMOTE) process.exit(0);

const common = require("../../lib/common.js");
common.resolveMcpRemoteBin = () => process.env.VW_TEST_FAKE_MCP_REMOTE;
// VW_TEST_CLAIM=1 forces the win32-only spawn claim on, with test-speed
// wait/poll timings, so the bridge's claim wiring runs on macOS/Linux CI.
if (process.env.VW_TEST_CLAIM === "1") {
  common.spawnClaimEnabled = () => true;
  const realAcquire = common.acquireSpawnSlot;
  common.acquireSpawnSlot = (url, opts) =>
    realAcquire(url, { waitMs: 1_500, pollMs: 50, ...opts });
}
// No subcommand, no passthrough args.
process.argv = process.argv.slice(0, 2);
require("../../bin/vibewatch-mcp.js");
