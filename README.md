# vibewatch-mcp

Connect any MCP client to your [Vibewatch](https://vibewatch.io) community-sentiment data.

Vibewatch's MCP server exposes eight read-only tools — seven over your organization's data (sentiment overview, sentiment trend, message search, daily insights, weekly reports, market context, and org details) plus public Stacks ecosystem sentiment. This package is a thin stdio bridge to that server: it wraps [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) with the Vibewatch server URL and auth handling built in, plus a one-command setup for [Buzz](https://github.com/block/buzz) agents.

## Use with Buzz

Two commands, one browser approval:

```bash
npm install -g vibewatch-mcp
vibewatch-mcp connect-buzz
```

`connect-buzz` signs you in to Vibewatch in the browser (no key to mint or copy), caches the sign-in for headless reuse, then registers the bridge in every agent harness it finds on your machine — Claude Code, Codex, and Goose. Restart your Buzz agents and they can answer questions from your community data.

Requires Node 18+. MCP access is opt-in per organization — an owner or admin enables it in [app.vibewatch.io](https://app.vibewatch.io) → **Settings → API Access**.

Worth knowing:

- The registration is **user scope**: every session of a configured harness on your machine can query Vibewatch, not just Buzz-spawned ones. The data is read-only community sentiment for your organization.
- To switch organizations, run `vibewatch-mcp connect-buzz --reset`.
- After upgrading vibewatch-mcp, run `connect-buzz` once more — the cached sign-in is keyed to the bundled `mcp-remote` version.
- To undo: `claude mcp remove --scope user vibewatch`, `codex mcp remove vibewatch`, or delete the `extensions.vibewatch` entry from `~/.config/goose/config.yaml` (Windows: `%APPDATA%\Block\goose\config\config.yaml`). Revoke the app's access any time from **Settings → API Access**.

For the full Vibewatch-on-Buzz install — report delivery into a channel plus a ready-made @vibewatch persona — open the **Buzz tile** under **Settings → Reports** in app.vibewatch.io and follow the setup walkthrough.

## Headless / CI: use a key instead

Where a browser sign-in isn't possible, an org-scoped key works everywhere the bridge runs:

1. In [app.vibewatch.io](https://app.vibewatch.io), open **Settings → API Access** and mint a key. Keys start with `vw_mcp_` and are shown once — store them like passwords.
2. Pass it to `connect-buzz` (`vibewatch-mcp connect-buzz --key vw_mcp_...`) or set it directly where the bridge runs:

```bash
claude mcp add --scope user vibewatch -e VIBEWATCH_MCP_KEY=vw_mcp_... -- vibewatch-mcp
```

Keys are org-scoped and read-only; revoke them any time from the same screen.

## Use with any stdio MCP client

Generic client config (Claude Desktop and compatible). GUI apps on macOS start with a minimal PATH, so use the absolute path from `which vibewatch-mcp`:

```json
{
  "mcpServers": {
    "vibewatch": {
      "command": "/opt/homebrew/bin/vibewatch-mcp"
    }
  }
}
```

With no `VIBEWATCH_MCP_KEY` set, the bridge uses the cached browser sign-in (run `connect-buzz` once to create it — or the client's first connection opens the sign-in page itself). Add an `env` block with `VIBEWATCH_MCP_KEY` to use a key instead.

The bridge owns sign-in tabs: `mcp-remote`'s own browser auto-open is disabled under the bridge, and the bridge opens the sign-in page itself — at most one tab machine-wide per sign-in, however many agent sessions are running. That covers mid-session re-auth too (a revoked or expired sign-in with many live sessions opens one tab, not one per session). If a sign-in page is never completed, the bridge won't open another one: later spawns (a client restarting the server, other agent sessions) exit with a pointer to `vibewatch-mcp connect-buzz` instead of opening more tabs. Sign in via `connect-buzz` (or complete the open tab) to clear it; after 24 hours an unanswered prompt expires and one fresh sign-in page is allowed again. On Windows, agent sessions launched at the same time also coordinate so only one of them opens the sign-in page — the others wait for it to finish.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `VIBEWATCH_MCP_KEY` | No | Org-scoped key (`vw_mcp_...`). When unset, the bridge uses the cached OAuth sign-in. |
| `VIBEWATCH_MCP_URL` | No | Override the server URL. Defaults to `https://api.vibewatch.io/mcp/`. |
| `VIBEWATCH_MCP_OPEN_CMD` | No | Override the browser opener the bridge uses for sign-in tabs (invoked with the URL as its single argument). For hosts where the platform default (`open`/`xdg-open`/`rundll32`) isn't right. |

Extra CLI arguments (e.g. `--debug`) pass through to `mcp-remote`.

The bridge never puts the key on a process argument list — it hands `mcp-remote` a `${VIBEWATCH_MCP_KEY}` placeholder and `mcp-remote` reads the value from the environment. One caveat: `connect-buzz --key` drives the harness CLIs (`claude mcp add -e ...`, `codex mcp add --env ...`), which only accept env values as arguments, so the key is briefly visible in those short-lived processes' argv. If that matters on your machine, use the browser sign-in instead — it involves no key at all.

## Tools

| Tool | What it returns |
|---|---|
| `get_sentiment_overview` | Current vibe score and how it moved |
| `get_sentiment_timeseries` | Daily sentiment trend over a date range |
| `search_messages` | Community messages matching a query |
| `get_daily_insights` | Daily highlights and themes |
| `get_reports` | Weekly report content |
| `get_market_context` | Market backdrop for sentiment reads |
| `get_organization` | Org and connected-source details |
| `get_stacks_ecosystem_sentiment` | Stacks ecosystem-wide vibe — public data, not this org's |

## Agent marketplace plugin

`plugins/vibewatch/` packages Vibewatch as an agent plugin — the hosted MCP server plus a
`use-vibewatch` skill — in the layout agent marketplaces resolve (xAI/Grok, Claude Code, Cursor,
and OpenAI Codex manifests, with marketplace manifests at the repo root). The plugin declares
exactly one network endpoint, `https://api.vibewatch.io/mcp/`, and carries no credentials: auth
is the server's standard MCP OAuth sign-in (or a `vw_mcp_` key via the stdio bridge for headless
use). It ships no hooks and no scripts. The plugin is versioned independently of this npm
package; `test/plugin-manifests.test.mjs` keeps the manifests in lockstep.

Until the marketplace listings are live, Claude Code users can install straight from the repo:

```
/plugin marketplace add Vibewatch-io/vibewatch-mcp
/plugin install vibewatch@vibewatch
```

The plugin and the `connect-buzz` flow register the same server under the same `vibewatch`
name — pick one per machine. If you've already run `connect-buzz`, either keep that and skip
the plugin, or remove the user-scope entry first (`claude mcp remove --scope user vibewatch`)
so the same tools aren't mounted twice.

Releasing a plugin change: bump the version in every `plugin.json` (the test enforces
equality), merge, then open a SHA-bump PR against `xai-org/plugin-marketplace` (their catalog
pins a commit, so Grok installs don't see changes until the pin advances). Other marketplaces
follow their own update flows.

## Stacks Vibe Index paid tier (x402)

The Stacks Vibe Index has a free tier and a paid tier. The free tier is the public index and the
weekly-report archive. The paid tier is depth per query, settled on Stacks over x402: the first
request answers `402` with payment terms, the client signs, and the retry carries the payment. No
key and no account are involved.

### Free

- `GET https://api.vibewatch.io/api/v1/public/stacks-index` — the live index: ecosystem
  composite, `projects[]` (each with `slug`, `name`, `score`), history, themes, governance, and
  `suppressed[]`. The `get_stacks_ecosystem_sentiment` MCP tool serves the same data.
- `GET https://api.vibewatch.io/api/v1/public/stacks-index/reports` — the weekly-report archive.
  Each entry's `week_start` is the key for paid evidence.

### Paid

Terms come from the discovery document at `https://api.vibewatch.io/.well-known/x402.json`. As of
2026-09-16 it advertises three resources, all on network `stacks:1`, paying to
`SP3PHGPE8G09FFBSH6NVM3J5S2118M8YA825HWQY1`, with two accepted assets listed in this order:

| Order | Asset | Amount per query |
|---|---|---|
| 1 | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` (sBTC) | `100` sats |
| 2 | `STX` | `300000` µSTX (0.3 STX) |

| Resource | Returns |
|---|---|
| `/api/v1/public/stacks-index/pro/projects/{slug}` | One panel project's daily composite series (`?days=`, up to 90) with its current score and week-over-week change. `slug` is the free index's `projects[].slug` verbatim; live slugs carry a suffix (e.g. `zest-protocol-3672`). |
| `/api/v1/public/stacks-index/pro/evidence/{week_start}` | The public posts backing each theme of one weekly report. `week_start` is a value from `reports`. |
| `/api/v1/public/stacks-index/pro/delta?since=<ISO-8601>` | What changed since a timestamp, hour-bucketed: per-project score moves, composite then and now, current themes, reports published since. `since` older than 90 days is clamped. |

One request is one payment; running the same query again pays again. Read the discovery
document before the first paid call: when the paid tier is switched off it serves empty
`accepts`.

### Paid response shape

Every paid response is the same envelope: `schema_version`, `tier: "paid"`, `as_of`,
`resource`, `payment`, `data`, `suppressed[]`.

- `payment` is the settlement the index verified for this response: `txid`, `payer`, `amount`,
  `asset`, `network`, and `payment_identifier` (the id we match against the ledger).
  `payment.txid` is the receipt to cite.
- `data` is the resource payload. `project`: `slug`, `name`, `latest { score, wow_change,
  as_of_date }`, `series[] { date, composite }` (scored days only, oldest first). `evidence`:
  `week_start`, `themes[]` with `receipts[]`; a theme with only in-server evidence has
  `receipts: []`, `suppressed: true`, `reason: "no_public_evidence"`. `delta`: `since_effective`,
  `index { composite_then, composite_now, change }`, `projects[]`, `reports_published[]`,
  `themes_current[]`.
- `suppressed[]` lists slices withheld for privacy (`slice`, `reason`, e.g. `below_min_orgs`).
  Report them as withheld, not zero.

### Unscored projects

A panel project whose free-index `score` is `null` (today `boom` and `jing-swap`) has no scored
days, so its paid series would be empty. Those slugs are refused before payment (rolling out).
Until that is live, the index still issues the `402` and, once paid, answers `200` with
`series: []` and `latest.score: null`, and the query is charged. Check `score` in the free index
before paying.

### How to pay

**aibtc MCP server** (`@aibtc/mcp-server`, tool `execute_x402_endpoint`). The tool handles the
`402` and the paid retry. It signs a non-sponsored transaction by default, so the wallet needs
STX for the network fee on top of the price. It also pays with the first asset it can sign, and
the terms list sBTC first, so a default call pays 100 sats sBTC. To pay in STX, pass the tool's
`asset` parameter:

```json
{
  "url": "https://api.vibewatch.io/api/v1/public/stacks-index/pro/projects/zest-protocol-3672",
  "params": { "days": "30" },
  "asset": "STX",
  "autoApprove": true
}
```

Leave `autoApprove` unset to get a cost quote first; the quote's `callWith` block carries `asset`
through to the paid call. `probe_x402_endpoint` takes the same `asset` parameter.

**aibtcdev/skills `vibewatch-sentiment`** ([source](https://github.com/aibtcdev/skills/tree/main/vibewatch-sentiment)).
The reference client: `index`, `terms`, and `reports` are free; `project`, `evidence`, and
`delta` are paid. It resolves a project name or slug against the free index before paying, checks
a `--week` against the report archive, and refuses an unscored project unless `--allow-unscored`
is passed. It has no asset switch and pays in sBTC. Run it with `--network mainnet` and
`NETWORK=mainnet`. Its payment engine signs a sponsored transaction by default; the index relays
those (sponsored relay switched on in production 2026-09-16), so a wallet holding only sBTC can
pay. Set `X402_PAYMENT_MODE=direct` (skills ≥ 0.43.0) to sign a standard transfer instead; the
wallet then also pays the STX fee. A `422` with `error: "sponsored_unsupported"` means the index
is not admitting sponsored transactions at that moment: switch to direct mode and hold STX for
gas.

For a payment that failed, charged unexpectedly, or returned something wrong, use the **Stacks
Index paid query problem** issue template; [Reporting a problem](#reporting-a-problem) below says
what it asks for.

## License

Apache-2.0

## Reporting a problem

Agents and operators: file issues here — this is the public tracker for the Vibewatch MCP server **and** the Stacks Vibe Index paid (x402) tier. Use the **Stacks Index paid query problem** template for anything involving a payment; it asks for the response body's `error` / `facilitator_reason` / `payment_identifier` and the txid, which is what we need to match your report to the ledger.
