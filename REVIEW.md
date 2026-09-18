# Code review calibration

The finding and evidence bar for every reviewer of this repo — native Codex, Cubic, CodeRabbit, a
direct Claude read. [CLAUDE.md](CLAUDE.md#review-tiers) alone governs ownership, roster and
completion; do not infer extra rounds or a different roster from this file.

The goal is to catch consequential defects before push. This package runs on customers' machines
with no CI and no staging branch between a merge and a publish, so a defect that ships is a defect
users install.

## What "Important" (🔴) means here

Reserve Important for findings that would break a user's install, leak a credential, or strand a
sign-in:

- **A key on an argument list or in output.** The bridge hands `mcp-remote` the literal
  `${VIBEWATCH_MCP_KEY}` placeholder and lets it expand the value from the environment
  (`bridgeArgs` in `lib/common.js`). Any change that interpolates the real key into argv, a log
  line, an error message, or a config file on disk is Important. Output that can echo a harness
  CLI's stderr goes through `redactKeys`.
- **Sign-in coordination broken.** The auth marker and the Windows spawn claim exist so that N
  live proxies hitting 401 open **one** sign-in tab machine-wide, and so a never-completed sign-in
  doesn't spawn more. Changes that let two processes open tabs, let a stale marker block sign-in
  past its TTL, or drop the atomic `flag: "wx"` / write-temp-then-`rename` discipline are
  Important. So is any takeover path that can steal a live claim.
- **Unbounded auth wait.** The pinned `mcp-remote` never times out its own authorization wait, so
  the bridge's timers are what stop a headless host hanging forever. Removing or widening one
  without a stated reason is Important.
- **Signature regexes loosened.** `AUTH_FAILURE_RE`, `AUTH_PROMPT_RE`, `AUTH_WAIT_RE` and
  `PROXY_UP_RE` match another program's stderr. Word boundaries are load-bearing — a bare `401`
  matches `mcp-remote`'s own callback port line and aborts a healthy sign-in.
- **`mcp-remote` version drift.** It is pinned exactly, with an `open` override, and
  `lib/no-auto-open.js` patches that specific version's opener spawn. A bump that doesn't re-verify
  the shim and the stderr signatures against the new release is Important.
- **Packaging breaks.** A new runtime file outside `bin/` or `lib/` is not in `package.json`
  `files` and will be missing from the published tarball. Syntax or APIs above the Node `>=18`
  engines floor are Important for the same reason.
- **Manifest drift.** Every `plugin.json` carries one version and every `mcp.json` the one
  canonical server URL (`test/plugin-manifests.test.mjs`). A plugin change that does not move all
  of them together ships a split-brain listing.
- **Cross-platform regressions** on the win32 spawn-claim path, the WSL opener, and the Goose
  config path — these have no coverage on a reviewer's own machine beyond the test suite.

Style, naming, refactoring, and preference stay Nit unless they materially block correctness.

## Cap the nits

Report **at most 5 Nits** per review. If you found more, say "plus N similar items" in the summary.
If everything you found is a Nit, lead with **"No blocking issues."**

## Always check

- Customer-facing copy — `README.md`, the `use-vibewatch` skill, marketplace descriptions,
  `.github/ISSUE_TEMPLATE/` — follows the brand voice
  ([`VOICE.md`](https://github.com/Vibewatch-io/vibewatch-docs/blob/main/brand/VOICE.md), not
  duplicated into this repo) and describes only affordances the bridge really has. Nothing in-repo
  enforces this, so it is yours to catch.
- Nothing internal lands in a public file: costs, quotas, unreleased plans, customer data, private
  infrastructure detail.
- New behavior that a user has to undo has an undo path in the README (the registration is user
  scope, and it survives the session that created it).
- A defect fix carries the regression test that fails without it, and no test's assertion was
  weakened to get green.

## Verification bar

Every behavioral finding needs a concrete trigger, the violated contract, the consequence, and
`file:line` evidence. Read the callers and the pinned `mcp-remote`'s actual behavior before
proposing a fix; do not infer a bug from a name. Distinguish a reproduced failure or a deterministic
code argument from a hypothesis. Check whether the proposed correction breaks another invariant,
error path, or platform. Missing tests are not themselves a behavioral defect. A verified material
defect stays material even when a tool's native scale labels it low; a high label does not prove a
claim.

## Re-review convergence

After the initial review, report material defects only and **zero Nits** — a re-review or
confirmation that finds only Nits returns `No blocking issues`. The dispatching driver pastes this
section into every re-review and confirmation prompt. On a confirmation, verify the accepted fixes
and their consequences in the correction delta and in the consumers of any contract it changed.
Repeat a settled finding only with materially new evidence. After the first correction round, an
optional improvement is declined or recorded as a tracked follow-up by default; accepting one needs
a stated reason, because each acceptance costs another gate run and another confirmation. Review is
complete at CLAUDE.md's completion floor, not when every reviewer is silent.

## Skip paths

- `package-lock.json` (mechanical)
- `node_modules/`

`test/fixtures/` warrants a higher bar rather than a skip: they are deliberately crude stand-ins
for `mcp-remote` and a bridge driver, so judge them only on whether they still model the real
behavior the test asserts, not on style.

## Summary shape

Open with a one-line tally: `N important, M nits` (or `No blocking issues`).
