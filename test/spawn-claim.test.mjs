import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  CLAIM_STALE_MS,
  acquireSpawnSlot,
  authMarkerPath,
  claimIsStale,
  claimPath,
  spawnClaimEnabled,
  tryTakeoverClaim,
  writeAuthMarker,
} = require("../lib/common.js");
const connect = require("../lib/connect.js");

const URL_A = "https://example.test/mcp/";
const FAST = { waitMs: 1_500, pollMs: 50 };

// async + await: with a plain `return fn(tmp)` the finally would restore
// the env at the async body's FIRST await, sending later polls at the real
// ~/.mcp-auth.
async function withTempCache(fn) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-claim-"));
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  process.env.MCP_REMOTE_CONFIG_DIR = tmp;
  try {
    return await fn(tmp);
  } finally {
    if (saved === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
}

function writeForeignClaim(url, { renewedAt = Date.now(), ownerId = "999-feedface0000" } = {}) {
  writeFileSync(
    claimPath(url),
    JSON.stringify({ ownerId, claimedAt: renewedAt, renewedAt }) + "\n"
  );
}

test("spawnClaimEnabled only on win32", () => {
  assert.equal(spawnClaimEnabled("win32"), true);
  assert.equal(spawnClaimEnabled("darwin"), false);
  assert.equal(spawnClaimEnabled("linux"), false);
});

test("acquire on a free path; release removes the claim", async () => {
  await withTempCache(async () => {
    const slot = await acquireSpawnSlot(URL_A, FAST);
    assert.equal(slot.status, "acquired");
    assert.ok(existsSync(claimPath(URL_A)));
    slot.release();
    assert.equal(existsSync(claimPath(URL_A)), false);
    slot.release(); // idempotent
  });
});

test("a live foreign claim makes the caller wait, then time out", async () => {
  await withTempCache(async () => {
    writeForeignClaim(URL_A);
    const before = Date.now();
    const slot = await acquireSpawnSlot(URL_A, FAST);
    assert.equal(slot.status, "timeout");
    assert.ok(Date.now() - before >= FAST.waitMs - 100);
    // The live owner's claim is untouched.
    assert.ok(existsSync(claimPath(URL_A)));
  });
});

test("a released claim lets a waiter acquire mid-wait", async () => {
  await withTempCache(async () => {
    writeForeignClaim(URL_A);
    const pending = acquireSpawnSlot(URL_A, { waitMs: 3_000, pollMs: 50 });
    const ownersClaimPath = claimPath(URL_A);
    setTimeout(() => {
      // The "owner" finishes and releases (what release() does on disk).
      rmSync(ownersClaimPath, { force: true });
    }, 200);
    const slot = await pending;
    assert.equal(slot.status, "acquired");
    slot.release();
  });
});

test("a stale claim is taken over; a live one is not", async () => {
  await withTempCache(async () => {
    writeForeignClaim(URL_A, { renewedAt: Date.now() - CLAIM_STALE_MS - 1_000 });
    const slot = await acquireSpawnSlot(URL_A, FAST);
    assert.equal(slot.status, "acquired");
    const claim = JSON.parse(readFileSync(claimPath(URL_A), "utf8"));
    assert.notEqual(claim.ownerId, "999-feedface0000");
    slot.release();
  });
});

test("a far-future renewedAt (clock jump) counts as stale", () => {
  assert.equal(
    claimIsStale({ ownerId: "x", renewedAt: Date.now() + CLAIM_STALE_MS * 2 }),
    true
  );
  assert.equal(claimIsStale({ ownerId: "x", renewedAt: Date.now() }), false);
  assert.equal(claimIsStale(null), true);
});

test("takeover verify-after-rename restores a live claim it stole", async () => {
  // The adversarial-review high finding: B decides "stale", A takes over
  // and wx-creates a FRESH claim, then B's rename lands on A's live file.
  // B must detect freshness post-rename and restore it, not delete it.
  await withTempCache(async () => {
    writeForeignClaim(URL_A, { ownerId: "111-aaaa00000000" }); // fresh = live
    const took = tryTakeoverClaim(URL_A, "222-bbbb00000000");
    assert.equal(took, false);
    const claim = JSON.parse(readFileSync(claimPath(URL_A), "utf8"));
    assert.equal(claim.ownerId, "111-aaaa00000000"); // restored intact
  });
});

test("takeover of a genuinely stale claim frees the path exactly once", async () => {
  await withTempCache(async () => {
    writeForeignClaim(URL_A, { renewedAt: Date.now() - CLAIM_STALE_MS - 1_000 });
    assert.equal(tryTakeoverClaim(URL_A, "111-aaaa00000000"), true);
    // Second contender's rename finds nothing — single winner.
    assert.equal(tryTakeoverClaim(URL_A, "222-bbbb00000000"), false);
  });
});

test("release never deletes a newer generation's claim", async () => {
  await withTempCache(async () => {
    const slot = await acquireSpawnSlot(URL_A, FAST);
    assert.equal(slot.status, "acquired");
    // Simulate a takeover: a new owner replaces the file.
    writeForeignClaim(URL_A, { ownerId: "333-cccc00000000" });
    slot.release();
    assert.ok(existsSync(claimPath(URL_A)));
    const claim = JSON.parse(readFileSync(claimPath(URL_A), "utf8"));
    assert.equal(claim.ownerId, "333-cccc00000000");
  });
});

test("gateMode bridge: marker + LIVE owner means keep waiting, not suppress", async () => {
  // The Codex P1 from review round 1: the owner writes the marker the
  // moment its sign-in tab opens, so suppressing on the marker alone made
  // every concurrent session fail during a sign-in instead of waiting.
  await withTempCache(async () => {
    writeForeignClaim(URL_A); // fresh = live owner
    writeAuthMarker(URL_A); // owner's tab is open right now
    const slot = await acquireSpawnSlot(URL_A, FAST);
    assert.equal(slot.status, "timeout"); // waited the window out
  });
});

test("gateMode bridge: marker + DEAD owner suppresses", async () => {
  await withTempCache(async () => {
    writeForeignClaim(URL_A, { renewedAt: Date.now() - CLAIM_STALE_MS - 1_000 });
    writeAuthMarker(URL_A); // the owner prompted, died, nobody completed it
    const slot = await acquireSpawnSlot(URL_A, FAST);
    assert.equal(slot.status, "suppress");
  });
});

test("post-acquire gate recheck: an unanswered marker on a free path suppresses and releases", async () => {
  await withTempCache(async () => {
    writeAuthMarker(URL_A); // no claim at all — prior owner failed and exited
    const slot = await acquireSpawnSlot(URL_A, FAST);
    assert.equal(slot.status, "suppress");
    assert.equal(existsSync(claimPath(URL_A)), false); // claim released
  });
});

test("renewal advances renewedAt; takeover flips lostOwnership and disarms release", async () => {
  await withTempCache(async () => {
    let lostCalls = 0;
    const slot = await acquireSpawnSlot(URL_A, {
      ...FAST,
      renewMs: 40,
      onLost: () => lostCalls++,
    });
    assert.equal(slot.status, "acquired");
    const first = JSON.parse(readFileSync(claimPath(URL_A), "utf8"));
    await new Promise((r) => setTimeout(r, 120));
    const renewed = JSON.parse(readFileSync(claimPath(URL_A), "utf8"));
    assert.ok(renewed.renewedAt > first.renewedAt, "renewal must advance renewedAt");
    // A takeover replaces the file; the old owner must notice and disarm.
    writeForeignClaim(URL_A, { ownerId: "444-dddd00000000" });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(slot.lostOwnership(), true);
    // The loss callback fires exactly once — the bridge uses it to kill
    // its child before it can prompt beside the successor.
    assert.equal(lostCalls, 1);
    slot.release();
    assert.ok(existsSync(claimPath(URL_A)), "release must not rm the new owner's claim");
  });
});

test("gateMode ignore (connect-buzz) waits through a marker", async () => {
  await withTempCache(async () => {
    writeForeignClaim(URL_A);
    writeAuthMarker(URL_A);
    const slot = await acquireSpawnSlot(URL_A, { ...FAST, gateMode: "ignore" });
    // The explicit recovery action is never marker-suppressed — it waits
    // out the live owner instead (and here times out).
    assert.equal(slot.status, "timeout");
  });
});

test("unusable claim storage returns unclaimed, not a crash", async () => {
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  // A file where the cache DIRECTORY should be makes mkdir/wx fail with
  // ENOTDIR — the non-EEXIST failure path.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-claim-"));
  const blocker = path.join(tmp, "not-a-dir");
  writeFileSync(blocker, "x");
  process.env.MCP_REMOTE_CONFIG_DIR = blocker;
  try {
    const slot = await acquireSpawnSlot(URL_A, FAST);
    assert.equal(slot.status, "unclaimed");
    assert.ok(slot.reason);
  } finally {
    if (saved === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
});

test("--reset clears a STALE claim (uncounted) but preserves a live one", async () => {
  await withTempCache(() => {
    // Live claim = another process mid-sign-in; deleting it would let this
    // reset open a second tab beside that session's (Codex P2, round 1).
    writeForeignClaim(URL_A);
    connect.resetCachedAuth(URL_A);
    assert.ok(existsSync(claimPath(URL_A)));
    writeForeignClaim(URL_A, { renewedAt: Date.now() - CLAIM_STALE_MS - 1_000 });
    // Removed, but NOT counted: a claim is not a cached sign-in, and
    // counting it would print "Cleared the cached sign-in" over nothing.
    assert.equal(connect.resetCachedAuth(URL_A), 0);
    assert.equal(existsSync(claimPath(URL_A)), false);
  });
});

test("marker and claim paths never collide", async () => {
  await withTempCache(() => {
    assert.notEqual(claimPath(URL_A), authMarkerPath(URL_A));
  });
});
