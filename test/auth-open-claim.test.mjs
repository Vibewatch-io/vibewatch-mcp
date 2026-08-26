import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  DEFAULT_URL,
  authMarkerPath,
  demoteAuthMarkerToWait,
  extractAuthUrl,
  readFreshAuthMarker,
  recordWaitMarker,
  retireSatisfiedAuthMarker,
  serverHash,
  tryClaimAuthPrompt,
  tryRetireAuthMarker,
} = require("../lib/common.js");

// Run each case against an isolated cache base (the marker path derives from
// MCP_REMOTE_CONFIG_DIR at call time).
function withTmpBase(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vw-mcp-claim-"));
  const saved = process.env.MCP_REMOTE_CONFIG_DIR;
  process.env.MCP_REMOTE_CONFIG_DIR = tmp;
  try {
    return fn(tmp);
  } finally {
    if (saved === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
    else process.env.MCP_REMOTE_CONFIG_DIR = saved;
  }
}

function writeMarker(fields) {
  fs.mkdirSync(path.dirname(authMarkerPath(DEFAULT_URL)), { recursive: true });
  fs.writeFileSync(
    authMarkerPath(DEFAULT_URL),
    JSON.stringify({ openedAt: Date.now(), ...fields }) + "\n"
  );
}

test("first claim wins and writes an `opened` marker", () => {
  withTmpBase(() => {
    assert.equal(tryClaimAuthPrompt(DEFAULT_URL).claimed, true);
    const marker = readFreshAuthMarker(DEFAULT_URL);
    assert.ok(marker);
    assert.equal(marker.kind, "opened");
  });
});

test("a second claim against a fresh `opened` marker is refused", () => {
  withTmpBase(() => {
    assert.equal(tryClaimAuthPrompt(DEFAULT_URL).claimed, true);
    assert.equal(tryClaimAuthPrompt(DEFAULT_URL).claimed, false);
  });
});

test("legacy markers (no kind field) block like `opened`", () => {
  withTmpBase(() => {
    writeMarker({}); // pre-#10 shape: {openedAt} only
    assert.equal(tryClaimAuthPrompt(DEFAULT_URL).claimed, false);
  });
});

test("a `wait` marker is upgraded: the prompt owner still claims and opens", () => {
  withTmpBase(() => {
    recordWaitMarker(DEFAULT_URL);
    assert.equal(readFreshAuthMarker(DEFAULT_URL).kind, "wait");
    assert.equal(tryClaimAuthPrompt(DEFAULT_URL).claimed, true);
    assert.equal(readFreshAuthMarker(DEFAULT_URL).kind, "opened");
  });
});

test("an expired marker is retired and reclaimed", () => {
  withTmpBase(() => {
    writeMarker({ openedAt: Date.now() - 25 * 60 * 60 * 1000 });
    assert.equal(tryClaimAuthPrompt(DEFAULT_URL).claimed, true);
    assert.equal(readFreshAuthMarker(DEFAULT_URL).kind, "opened");
  });
});

test("a satisfied marker (newer tokens landed) is retired and reclaimed", () => {
  withTmpBase((tmp) => {
    writeMarker({ openedAt: Date.now() - 10 * 60 * 1000 });
    // Tokens written after openedAt, in a version-keyed dir like mcp-remote's.
    const tokensDir = path.join(tmp, "mcp-remote-0.0.0");
    fs.mkdirSync(tokensDir, { recursive: true });
    fs.writeFileSync(
      path.join(tokensDir, `${serverHash(DEFAULT_URL)}_tokens.json`),
      "{}"
    );
    assert.equal(tryClaimAuthPrompt(DEFAULT_URL).claimed, true);
  });
});

test("corrupt marker JSON fails open: the claim proceeds", () => {
  withTmpBase(() => {
    fs.mkdirSync(path.dirname(authMarkerPath(DEFAULT_URL)), {
      recursive: true,
    });
    fs.writeFileSync(authMarkerPath(DEFAULT_URL), "{not json");
    assert.equal(tryClaimAuthPrompt(DEFAULT_URL).claimed, true);
  });
});

test("recordWaitMarker never clobbers a claimant's `opened` marker", () => {
  withTmpBase(() => {
    assert.equal(tryClaimAuthPrompt(DEFAULT_URL).claimed, true);
    const before = readFreshAuthMarker(DEFAULT_URL);
    recordWaitMarker(DEFAULT_URL);
    const after = readFreshAuthMarker(DEFAULT_URL);
    assert.equal(after.kind, "opened");
    assert.equal(after.openedAt, before.openedAt);
  });
});

test("recordWaitMarker writes when nothing stands, and leaves a fresh wait marker alone", () => {
  withTmpBase(() => {
    recordWaitMarker(DEFAULT_URL);
    const first = readFreshAuthMarker(DEFAULT_URL);
    assert.equal(first.kind, "wait");
    recordWaitMarker(DEFAULT_URL);
    assert.equal(readFreshAuthMarker(DEFAULT_URL).openedAt, first.openedAt);
  });
});

// --- demoteAuthMarkerToWait (ownership handshake, re-review P1) ---

test("demote turns this phase's own `opened` marker into `wait`", () => {
  withTmpBase(() => {
    const claim = tryClaimAuthPrompt(DEFAULT_URL);
    assert.equal(claim.claimed, true);
    assert.ok(claim.claimId);
    demoteAuthMarkerToWait(DEFAULT_URL, claim.claimId);
    assert.equal(readFreshAuthMarker(DEFAULT_URL).kind, "wait");
  });
});

test("demote leaves a DIFFERENT claim's `opened` marker untouched", () => {
  withTmpBase(() => {
    // A late opener-failure callback carrying another phase's identity —
    // openedAt can collide within a millisecond, so the handshake is the
    // random claimId — must not clobber the claim now on disk.
    const claim = tryClaimAuthPrompt(DEFAULT_URL);
    assert.equal(claim.claimed, true);
    demoteAuthMarkerToWait(DEFAULT_URL, "feedfacefeedface");
    const after = readFreshAuthMarker(DEFAULT_URL);
    assert.equal(after.kind, "opened");
    assert.equal(after.claimId, claim.claimId);
  });
});

test("demote without a claimId handshake is a no-op", () => {
  withTmpBase(() => {
    const claim = tryClaimAuthPrompt(DEFAULT_URL);
    assert.equal(claim.claimed, true);
    demoteAuthMarkerToWait(DEFAULT_URL, undefined);
    assert.equal(readFreshAuthMarker(DEFAULT_URL).kind, "opened");
  });
});

// --- retireSatisfiedAuthMarker (coarse-mtime completion, re-review P1) ---

test("a completed sign-in retires even when token mtime ties the claim (coarse mtime)", () => {
  withTmpBase((tmp) => {
    const claim = tryClaimAuthPrompt(DEFAULT_URL);
    assert.equal(claim.claimed, true);
    // Token write truncated into the same (or an earlier) timestamp bucket
    // as the claim — strictly-newer says unsatisfied, the graced judgment
    // says satisfied.
    const tokensDir = path.join(tmp, "mcp-remote-0.0.0");
    fs.mkdirSync(tokensDir, { recursive: true });
    const tokensPath = path.join(
      tokensDir,
      `${serverHash(DEFAULT_URL)}_tokens.json`
    );
    fs.writeFileSync(tokensPath, "{}");
    const tied = new Date(claim.openedAt - 500);
    fs.utimesSync(tokensPath, tied, tied);
    assert.equal(tryRetireAuthMarker(DEFAULT_URL), false, "strict declines");
    assert.equal(retireSatisfiedAuthMarker(DEFAULT_URL), true);
    assert.equal(readFreshAuthMarker(DEFAULT_URL), null);
  });
});

test("retireSatisfiedAuthMarker leaves a live unsatisfied claim standing", () => {
  withTmpBase(() => {
    const claim = tryClaimAuthPrompt(DEFAULT_URL);
    assert.equal(claim.claimed, true);
    assert.equal(retireSatisfiedAuthMarker(DEFAULT_URL), false);
    assert.equal(readFreshAuthMarker(DEFAULT_URL).claimId, claim.claimId);
  });
});

// --- extractAuthUrl ---

test("extractAuthUrl finds URLs inline and standalone, and validates protocol", () => {
  assert.equal(
    extractAuthUrl("Please authorize this client by visiting: https://a.test/x?b=1&c=2"),
    "https://a.test/x?b=1&c=2"
  );
  assert.equal(
    extractAuthUrl("https://a.test/authorize?request_id=r1"),
    "https://a.test/authorize?request_id=r1"
  );
  assert.equal(extractAuthUrl("no url here"), null);
  assert.equal(extractAuthUrl("visit file:///etc/passwd"), null);
});
