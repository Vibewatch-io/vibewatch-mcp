import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  AUTH_MARKER_TTL_MS,
  TOKENS_GRACE_MS,
  authMarkerPath,
  clearAuthMarker,
  newerTokensExist,
  oauthSpawnGate,
  readFreshAuthMarker,
  serverHash,
  writeAuthMarker,
} = require("../lib/common.js");
const connect = require("../lib/connect.js");

const bin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "vibewatch-mcp.js"
);

const URL_A = "https://example.test/mcp/";

/** Run fn with MCP_REMOTE_CONFIG_DIR pointed at a fresh temp cache dir. */
function withTempCache(fn) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vw-mcp-marker-"));
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  process.env.MCP_REMOTE_CONFIG_DIR = tmp;
  try {
    return fn(tmp);
  } finally {
    if (saved === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
}

function writeTokens(tmp, url, versionDir, mtimeMs) {
  const dir = path.join(tmp, versionDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${serverHash(url)}_tokens.json`);
  writeFileSync(file, "{}");
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test("writeAuthMarker/readFreshAuthMarker roundtrip, per-server keying", () => {
  withTempCache(() => {
    writeAuthMarker(URL_A);
    const marker = readFreshAuthMarker(URL_A);
    assert.ok(marker);
    assert.ok(Math.abs(Date.now() - marker.openedAt) < 5_000);
    // A different server's marker is a different file.
    assert.equal(readFreshAuthMarker("https://other.test/mcp/"), null);
  });
});

test("an expired marker reads as absent — the TTL deliberately allows one new prompt", () => {
  // Accepted behavior (issue #4, kept after adversarial review): while a
  // sign-in stays missing, marker expiry means a passive host retry may
  // open at most one fresh tab per server per TTL window.
  withTempCache(() => {
    writeFileSync(
      authMarkerPath(URL_A),
      JSON.stringify({ openedAt: Date.now() - AUTH_MARKER_TTL_MS - 1_000 })
    );
    assert.equal(readFreshAuthMarker(URL_A), null);
    assert.equal(oauthSpawnGate(URL_A), "clear");
  });
});

test("any future openedAt (clock moved backward) reads as absent", () => {
  // Tolerating a future marker would extend suppression past the TTL after
  // a backwards clock jump; rejecting it costs at most one extra prompt,
  // which rewrites the marker at the current clock.
  withTempCache(() => {
    writeFileSync(
      authMarkerPath(URL_A),
      JSON.stringify({ openedAt: Date.now() + 5_000 })
    );
    assert.equal(readFreshAuthMarker(URL_A), null);
    writeFileSync(
      authMarkerPath(URL_A),
      JSON.stringify({ openedAt: Date.now() + AUTH_MARKER_TTL_MS + 1_000 })
    );
    assert.equal(readFreshAuthMarker(URL_A), null);
  });
});

test("corrupt, empty, or wrong-shape markers read as absent (fail open)", () => {
  withTempCache(() => {
    writeFileSync(authMarkerPath(URL_A), "not json");
    assert.equal(readFreshAuthMarker(URL_A), null);
    writeFileSync(authMarkerPath(URL_A), "");
    assert.equal(readFreshAuthMarker(URL_A), null);
    writeFileSync(authMarkerPath(URL_A), JSON.stringify({ openedAt: "soon" }));
    assert.equal(readFreshAuthMarker(URL_A), null);
  });
});

test("clearAuthMarker removes the marker and is silent when absent", () => {
  withTempCache(() => {
    writeAuthMarker(URL_A);
    clearAuthMarker(URL_A);
    assert.equal(existsSync(authMarkerPath(URL_A)), false);
    clearAuthMarker(URL_A); // no throw on a missing file
  });
});

test("newerTokensExist: only tokens newer than the cutoff count, any version dir", () => {
  withTempCache((tmp) => {
    const now = Date.now();
    // Stale token in one version dir, fresh token in another.
    writeTokens(tmp, URL_A, "mcp-remote-0.1.37", now - 60_000);
    assert.equal(newerTokensExist(URL_A, now - 1_000), false);
    writeTokens(tmp, URL_A, "mcp-remote-0.1.38", now + 60_000);
    assert.equal(newerTokensExist(URL_A, now - 1_000), true);
    // Another server's tokens never count.
    assert.equal(newerTokensExist("https://other.test/mcp/", 0), false);
  });
});

test("newerTokensExist is false on a missing cache base", () => {
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  process.env.MCP_REMOTE_CONFIG_DIR = path.join(
    os.tmpdir(),
    "vw-mcp-definitely-missing"
  );
  try {
    assert.equal(newerTokensExist(URL_A, 0), false);
  } finally {
    if (saved === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
});

test("oauthSpawnGate: fresh marker suppresses; pre-existing stale tokens do NOT lift it", () => {
  // The adversarial-review high finding, restated for the watermark: token
  // state the claim already observed (old version, revoked, corrupt) must
  // not bypass the cap — only a token write that LANDED after the claim
  // (a completed sign-in) may.
  withTempCache((tmp) => {
    assert.equal(oauthSpawnGate(URL_A), "clear");
    // Stale tokens exist BEFORE the marker — the claim's tokensSeen
    // watermark captures them.
    writeTokens(tmp, URL_A, "mcp-remote-0.1.37", Date.now() - TOKENS_GRACE_MS * 2);
    writeAuthMarker(URL_A);
    assert.equal(oauthSpawnGate(URL_A), "suppress");
    // A genuine completion (the token file changes) lifts it.
    writeTokens(tmp, URL_A, "mcp-remote-0.1.38", Date.now());
    assert.equal(oauthSpawnGate(URL_A), "satisfied");
  });
});

test("oauthSpawnGate: tokens slightly OLDER than the marker still satisfy it", () => {
  // A bridge that lost the sign-in lockfile race writes its marker moments
  // after the winner's tokens landed (its shared-auth wait never completes
  // in the pinned mcp-remote) — without the grace window that ordering
  // would suppress a correctly signed-in user for the whole TTL. Coarse
  // (1s) filesystem mtimes have the same shape.
  withTempCache((tmp) => {
    writeAuthMarker(URL_A);
    const { openedAt } = readFreshAuthMarker(URL_A);
    writeTokens(tmp, URL_A, "mcp-remote-0.1.38", openedAt - TOKENS_GRACE_MS / 2);
    assert.equal(oauthSpawnGate(URL_A), "satisfied");
  });
});

test("resetCachedAuth clears the pending-auth marker too, and counts it", () => {
  withTempCache(() => {
    writeAuthMarker(URL_A);
    // In the exact issue-#4 state (marker, no tokens) reset must report
    // that it cleared something — the suppression really was lifted.
    assert.equal(connect.resetCachedAuth(URL_A), 1);
    assert.equal(existsSync(authMarkerPath(URL_A)), false);
    assert.equal(connect.resetCachedAuth(URL_A), 0);
  });
});

// A non-routable host for bin-level suppression tests: if the gate ever
// regresses, the bridge must spawn mcp-remote against this — a contained
// failure — rather than against the production server.
const BOGUS_URL = "https://vibewatch-test.invalid/mcp/";

test("bridge: suppressed spawn exits 1 with guidance and opens nothing", () => {
  withTempCache((tmp) => {
    writeAuthMarker(BOGUS_URL);
    const env = {
      ...process.env,
      MCP_REMOTE_CONFIG_DIR: tmp,
      VIBEWATCH_MCP_URL: BOGUS_URL,
    };
    delete env.VIBEWATCH_MCP_KEY;
    const result = spawnSync(process.execPath, [bin], {
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already opened and never completed/);
    assert.match(result.stderr, /connect-buzz/);
    // The marker survives the suppressed exit — the NEXT respawn is capped
    // too (clearing it here would alternate tab, skip, tab, skip...).
    assert.ok(existsSync(authMarkerPath(BOGUS_URL)));
    // mcp-remote was never spawned — none of its startup output appears.
    assert.doesNotMatch(result.stderr, /Proxy established|mcp-remote/i);
  });
});

test("bridge: a malformed key downgrades to OAuth mode and hits the cap", () => {
  withTempCache((tmp) => {
    writeAuthMarker(BOGUS_URL);
    // A value failing the vw_mcp_ prefix check flips the bridge back to
    // OAuth mode, so the suppression gate must apply there too.
    const env = {
      ...process.env,
      MCP_REMOTE_CONFIG_DIR: tmp,
      VIBEWATCH_MCP_URL: BOGUS_URL,
      VIBEWATCH_MCP_KEY: "not-a-vibewatch-key",
    };
    const result = spawnSync(process.execPath, [bin], {
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
    // Malformed key → ignored → OAuth mode → suppressed by the marker.
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ignoring VIBEWATCH_MCP_KEY/);
    assert.match(result.stderr, /already opened and never completed/);
  });
});
