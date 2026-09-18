# vibewatch-mcp — Development Guide

This repo publishes the npm package **`vibewatch-mcp`**: a stdio bridge that connects any MCP
client to the hosted Vibewatch MCP server at `https://api.vibewatch.io/mcp/` by wrapping
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote), plus `vibewatch-mcp connect-buzz`
(one-command browser sign-in and harness registration) and the Vibewatch **agent-marketplace
plugin** under `plugins/vibewatch/`.

**This repository is public and the package is installed on customers' machines.** Everything
committed here is world-readable: no internal costs, quotas, unreleased plans, customer data, or
private infrastructure detail in any file. Linking to a private repo is fine; describing its
contents here is not.

**Customer-facing copy** — `README.md`, `plugins/vibewatch/skills/use-vibewatch/SKILL.md`, the
marketplace descriptions, and `.github/ISSUE_TEMPLATE/` are read by customers and by agents. They
follow the brand voice **before they ship**. The single source of truth is
[`VOICE.md`](https://github.com/Vibewatch-io/vibewatch-docs/blob/main/brand/VOICE.md) in
[`vibewatch-docs`](https://github.com/Vibewatch-io/vibewatch-docs) — read it before writing
customer-facing copy, and never copy its rules into this repo (a second copy silently drifts).
Anything visual (the plugin logo, social images) follows
[`STYLE_GUIDE.md`](https://github.com/Vibewatch-io/vibewatch-docs/blob/main/brand/STYLE_GUIDE.md),
same rule. Copy must describe only affordances the bridge really has.

---

## What's here

| Path | What it is |
|---|---|
| `bin/vibewatch-mcp.js` | The bridge entry point: spawns the pinned `mcp-remote` against the server URL, watches its stderr for auth signatures, owns the sign-in tab, bounds the auth wait. |
| `lib/common.js` | Shared internals: default URL, `mcp-remote` stderr signature regexes, auth-marker files, the Windows spawn-claim, browser opening, `bridgeArgs`. |
| `lib/connect.js` | `connect-buzz` — browser (or `--key`) sign-in, then user-scope registration in Claude Code, Codex and Goose. |
| `lib/goose-config.js` | Pure YAML editing for `~/.config/goose/config.yaml` (Goose has no non-interactive CLI). |
| `lib/no-auto-open.js` | `--require` preload that neuters the pinned `mcp-remote`'s own browser auto-open, so the bridge opens at most one sign-in tab machine-wide. |
| `plugins/vibewatch/` | The agent plugin: `.mcp.json` + per-ecosystem `plugin.json` (Claude Code, Codex, Cursor, Grok) + the `use-vibewatch` skill. |
| `.claude-plugin/`, `.cursor-plugin/`, `.agents/plugins/` | Marketplace manifests that point at `plugins/vibewatch`. |
| `test/` | `node --test` suite, including `plugin-manifests.test.mjs`, which keeps every manifest's version and server URL in lockstep. |
| `README.md` | The customer-facing setup doc — install, auth, env vars, tools, the Stacks Index paid (x402) tier. |

`package.json` `files` is **`bin/` and `lib/` only**. A new runtime file outside those two
directories is missing from the published tarball and the package breaks on install; docs, tests
and the plugin are repo-only by design.

## Gates

```bash
npm ci
npm test        # node --test — the whole suite, ~20s
git diff --check
```

There is **no linter, no formatter, and no CI workflow in this repo**: the test suite plus the
review roster is the entire gate, so an unrun suite is an unverified change. `engines` is Node
`>=18` — local dev may be far newer, so don't use syntax or APIs that Node 18 lacks. Hook changes
get `bash -n` / `python3 -m py_compile`.

Run the gates **once on the assembled batch**, not after every edit; reuse a green run whose
relevant inputs and tree are unchanged, and otherwise rerun only what the change affects. Parts of
the suite exercise real timeouts and lock contention, so it is slow on purpose — don't shorten a
wait to make it faster.

**Test-worthiness bar.** Every test is paid for on every future run and every reviewer read. Add
one for a fixed defect, a new branch or contract, or a named failure mode (a cross-platform path, a
race, a stderr signature), and say in the PR which bug class it catches. None for a rename, a
comment, or coverage for its own sake. Never weaken a behavioral assertion to get green.

## Publishing and versioning

Two independently versioned artifacts:

- **The npm package.** The version bump is its own `release: <version>` PR to `main` that touches
  `package.json` + `package-lock.json` and nothing else. **`npm publish` is the owner's step** —
  a session never publishes, and never bumps the version as part of a feature PR.
- **The agent plugin.** Every `plugin.json` under `plugins/vibewatch/` carries one version, enforced by
  `test/plugin-manifests.test.mjs`; the release is tagged `plugin-v<version>` with a GitHub
  release. The xAI catalog pins a commit SHA, so a plugin change also needs a SHA-bump PR against
  `xai-org/plugin-marketplace` before Grok installs see it (README, "Agent marketplace plugin").

`mcp-remote` is pinned to an exact version with an `open` override, and `lib/no-auto-open.js`
depends on that pinned version's internals. Bumping it is a T3 change: re-verify the shim and the
stderr signature regexes against the new release, and remember that the cached sign-in is keyed to
the bundled `mcp-remote` version, so users must re-run `connect-buzz` after an upgrade.

---

## One driver owns the change

The **driver** is the user-facing session that owns the branch until an explicit handoff. It owns
the plan, the implementation, the tests, finding decisions, corrections, and the PR. A nested
invocation is a delegate, not a new driver: it cannot commit, push, open a PR, or declare review
complete.

**Implementation is Claude-authored** — the driver writes it, or a Claude delegate does under a
bounded contract. **Codex is read-only** here: plan critique and review. The exception is an
owner-requested Codex implementation asked for in the session, and the PR then says why. Inspect a
delegate's actual diff and reproduce any reported failure before continuing; a failed handoff is a
reason for a precise diagnosis, not for discarding working code or re-dispatching the same vague
request.

**Dispatching a delegate.** A review is a separate read-only process. An implementation delegate
gets explicit writable files, the intended behavior and invariants, the tests to run, and a
no-submission instruction; it returns the diff, real machine output, and any unfinished work
honestly. Point it at source and contracts instead of pasting code. The driver stays accountable
for completion.

### Model routing

| Role | Assignment |
|---|---|
| Driver: planning, implementation, triage, integration | User's session model |
| Native Codex plan critique and correctness review | `gpt-5.6-terra` + `high`, pinned explicitly on each dispatch |
| Sensitive/architecture Codex escalation | `gpt-5.6-sol` + `high` when a concrete risk warrants it; state the reason |
| Direct Claude plan critique or fallback review | `opus` + `high`, separate restricted CLI process |
| Claude delegate — reads, digests, implementation slices, gate batches | Driver's choice of `opus` / `sonnet` / `haiku` by task, passed explicitly on every dispatch |
| Codex implementation authoring | Off by default; owner-requested only, then `gpt-5.6-terra` + `high` |

Pick the delegate's model for the task at hand — `opus` when the slice needs judgment, `sonnet`
when the contract is fully specified, `haiku` for digests, lookups and status — and name it on the
dispatch so the choice is deliberate rather than inherited. Judgment stays on the session model:
planning, risk classification, finding triage, and reading any diff it did not write. Two kinds of
work never run in the driver's own turns — watching a PR, and reads whose output it would only
summarize (multi-file exploration, log digests). Never launch a reviewer with an unnamed model or
silently raised effort.

### The driver workflow

1. **Plan.** For non-trivial work, write a session-local plan and get a different-vendor critique
   before implementing (Claude driver → Codex). Record each critique as closing-now or
   deferred-with-reason. Trivial mechanical work may skip this with a reason.
2. **Build.** Branch from `origin/main` in the session's own worktree (`.claude/worktrees/` is the
   convention here and is gitignored). Never work in the main checkout's tree.
3. **Verify.** Run the gates above once on the assembled batch.
4. **Review.** Check the final diff against the critique dispositions, then run the tier's roster
   locally, **before push**. Review the full branch change and the surrounding code. A plan
   critique is not an implementation review.
5. **Correct and confirm.** Verify each finding against the actual contract, batch accepted fixes,
   test them, and get one independent confirming read.
6. **Submit.** When the completion floor is met: commit, push, open the PR, hand the watch to the
   host, end the turn.

## Review tiers

Risk sets review depth, not who typed the code. **Cubic is a distinct reviewer harness** (AI Wiki,
learned patterns, dashboard context); its BYO CLI runs on Claude's subscription, which does not make
it equivalent to a direct Claude read.

| Tier | Applies to | Initial pre-push review |
|---|---|---|
| **T0 — Editorial** | Docs, comments, and copy that change no consumed contract or operating rule | One independent read: Cubic by default, direct Claude or native Codex as fallback |
| **T1 — Low risk** | Small single-surface behavior change, no sensitive surface | Native Codex + Cubic |
| **T2 — Default** | Other behavior changes, including changes to this file's rules | Native Codex + Cubic |
| **T3 — Sensitive** | Publishing and packaging (`version`, `files`, `bin`, `dependencies`, the `mcp-remote` pin); auth and token handling (keys, the OAuth cache, auth markers, the spawn claim); anything that changes what an installed user executes; the server URL and other public contracts; the plugin and marketplace manifests | Native Codex + Cubic, with the relevant failure modes named explicitly; Codex may escalate as above |

Both core reads must complete for T1–T3. If one cannot, report the missing capability and block
submission rather than silently thinning the gate — direct Claude may substitute for an unavailable
Cubic, recorded as a substitution. Empty responses, wrong base, permission failures and timeouts are
degraded, never clean. Both-core is the **initial** review; a correction confirmation takes one
independent read, and a T0 correction takes none. CodeRabbit is opt-in supplementary coverage that
never blocks an ordinary PR — never wait out its rate limit. Reviewer calibration (severity bar, nit
cap, what to always check in this repo) is [REVIEW.md](REVIEW.md).

**Completion floor.** The required initial reads completed on the intended branch state; every
material finding has an evidence-backed disposition; the gates are green on the final behavior; and
any accepted correction has its independent confirmation. No unresolved verified material defect
hides behind a severity label, a quota limit, or a round count. **Rounds are budgeted:** after two
correction rounds that each produced a new verified defect, a further batch needs the user's
go-ahead in the session; past four rounds, stop and take every open finding to the user classified.
Review ends at this floor, not when reviewers run out of ideas — optional nits and repeats without
new evidence do not reopen it.

## Git rules

- **Never push to `main`.** Every change goes through a PR from a feature branch. `main` is the
  branch this package publishes from, and this rule plus the `.claude/hooks/` branch guards are
  what keep a session off it.
- Branch names describe the feature, never the agent: `feature/<name>`, `fix/<name>`,
  `docs/<name>`.
- **Take completed work to PR without waiting for a second prompt.** The PR is the deliverable.
  One PR per session.
- **After `gh pr create`, hand the watch to the host and end the turn** — the desktop app's PR
  monitor with auto-fix, or a single deadline-bounded terminal monitor elsewhere. No polling loop,
  no status-only turns. If the host has no monitor, say so and hand off the URL. When woken, fix
  verified defects under the same correction and confirmation rules, and batch pushes.
- **Never self-merge** unless explicitly asked; surface human review comments to the user rather
  than acting on them unilaterally.
- Force-pushes, `reset --hard`, `branch -D` and `--no-verify` need explicit approval each time.
- `npm publish` and version tags are the owner's, never a session's.

## Where the long-form rules live

This file carries what must be known *before* the task is understood. The mechanics live once, in
[`vibewatch-app`](https://github.com/Vibewatch-io/vibewatch-app), and are not mirrored here:

| For | Read |
|---|---|
| Review sequencing, fix-round re-entry, convergence | [multi-agent-review.md](https://github.com/Vibewatch-io/vibewatch-app/blob/rc/docs/workflow/multi-agent-review.md) |
| Reviewer CLI commands, auth preflights, Codex dispatch, PR-watch mechanics | [review-tooling.md](https://github.com/Vibewatch-io/vibewatch-app/blob/rc/docs/workflow/review-tooling.md) |
| Brand voice (customer-facing copy) | [VOICE.md](https://github.com/Vibewatch-io/vibewatch-docs/blob/main/brand/VOICE.md) |
| Design (anything visual) | [STYLE_GUIDE.md](https://github.com/Vibewatch-io/vibewatch-docs/blob/main/brand/STYLE_GUIDE.md) |

Those repos are private; their rules are not restated here. Where this file and a linked document
disagree about ownership, tiers, or the completion floor for *this* repo, this file wins — and the
disagreement is a defect to fix, not an alternate policy.

This guide is a map of what is true now, not a changelog. Most PRs change nothing in it: edit it
when the structure, a gate, or a rule actually changes, and delete rather than leave a dated note —
git already holds the history.
