# vibewatch-mcp

Connect any MCP client to your [Vibewatch](https://vibewatch.io) community-sentiment data.

Vibewatch's MCP server exposes six read-only tools over your organization's data — sentiment overview, message search, daily insights, weekly reports, market context, and org details. This package is a thin stdio bridge to that server: it wraps [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) with the Vibewatch server URL and key handling built in, so agents that speak stdio MCP (Buzz agents, Claude Code, Goose, Codex) connect with one binary and one environment variable.

## Install

```bash
npm install -g vibewatch-mcp
```

Requires Node 18+.

## Get a key

1. In [app.vibewatch.io](https://app.vibewatch.io), open **Settings → API Access**.
2. MCP access is opt-in per organization — an owner or admin enables it there.
3. Mint a key. Keys start with `vw_mcp_` and are shown once — store it like a password.

The key is org-scoped and read-only. Revoke it any time from the same screen.

## Use with Buzz

Buzz attaches one MCP server binary to every agent it spawns via `BUZZ_ACP_MCP_COMMAND` (a bare binary path, no arguments — which is why this wrapper exists). Set both variables in the environment your Buzz harness runs in:

```bash
export BUZZ_ACP_MCP_COMMAND="$(command -v vibewatch-mcp)"
export VIBEWATCH_MCP_KEY="vw_mcp_..."
```

Every agent in the workspace can then answer questions from your community data. To set up the full Vibewatch-on-Buzz install — report delivery into a channel plus a ready-made @vibewatch persona — open the **Buzz tile** under **Settings → Reports** in app.vibewatch.io and follow the setup walkthrough.

## Use with any stdio MCP client

Claude Code:

```bash
claude mcp add vibewatch --env VIBEWATCH_MCP_KEY=vw_mcp_... -- vibewatch-mcp
```

Generic client config (Claude Desktop and compatible):

```json
{
  "mcpServers": {
    "vibewatch": {
      "command": "vibewatch-mcp",
      "env": {
        "VIBEWATCH_MCP_KEY": "vw_mcp_..."
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `VIBEWATCH_MCP_KEY` | Yes | Your org-scoped MCP key (`vw_mcp_...`). The bridge exits with a clear error if unset. |
| `VIBEWATCH_MCP_URL` | No | Override the server URL. Defaults to `https://api.vibewatch.io/mcp/`. |

Extra CLI arguments (e.g. `--debug`) pass through to `mcp-remote`.

The key never appears in the process argument list — the bridge hands `mcp-remote` a `${VIBEWATCH_MCP_KEY}` placeholder and `mcp-remote` reads the value from the environment.

## Tools

| Tool | What it returns |
|---|---|
| `get_sentiment_overview` | Current vibe score and how it moved |
| `search_messages` | Community messages matching a query |
| `get_daily_insights` | Daily highlights and themes |
| `get_reports` | Weekly report content |
| `get_market_context` | Market backdrop for sentiment reads |
| `get_organization` | Org and connected-source details |

## License

Apache-2.0
