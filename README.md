# Serval Multi-Agent IT Orchestrator (Cloudflare)

A multi-agent orchestrator that operates [Serval](https://www.serval.com/) ITSM over MCP — a Supervisor Durable Object delegates to Triage / Access-Review / Onboarding specialist Durable Objects, each running a Claude tool-loop (via Cloudflare AI Gateway) against a co-located mock Serval `McpAgent`. Deploys on Cloudflare.

## Requirements
- Node 20+ and a Cloudflare account (`wrangler login`)
- An Anthropic API key; a Cloudflare AI Gateway (`CF_ACCOUNT_ID`, `GATEWAY_ID`)

## Setup
```bash
npm install
cp .dev.vars.example .dev.vars   # set ANTHROPIC_API_KEY, CF_ACCOUNT_ID, GATEWAY_ID
npx wrangler types
```

## Run locally
```bash
npm run dev     # wrangler dev → http://localhost:8787
npm test        # unit tests (policy, operations, tool conversion, routing)
```
Open `http://localhost:8787/` and click a scenario. Inspect the mock MCP server at `/mcp` with `npx @modelcontextprotocol/inspector` (Streamable HTTP, `http://localhost:8787/mcp`).

## Deploy
```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put GATEWAY_ID
npx wrangler deploy
```

## Architecture
Supervisor (Claude Opus 4.8) → specialist Durable Objects via `getAgentByName()` RPC, parallel fan-out. Each specialist is scoped to a slice of Serval MCP tools and returns a distilled, schema-validated Finding. The live trace streams to the console over SSE. The mock Serval backend is an `McpAgent` exposing 12 tools (Streamable HTTP at `/mcp`, plus the v0.6.0 RPC transport used internally). See `docs/superpowers/` for the full design and plan.

## Real Serval
Set `SERVAL_MODE=live`, `SERVAL_MCP_URL`, `SERVAL_TOKEN` (workspace credentials). The specialists' MCP client targets real Serval instead of the mock binding; tool names/shapes are identical, so no agent code changes.

## Layout
```
src/
  index.ts            Worker entry + routing (/mcp, /api/run, /agents, assets)
  mcp/serval.ts       ServalMCP McpAgent (12 tools, stateful seeds)
  mcp/operations.ts   pure tool operations (unit-tested)
  agents/             supervisor + 3 specialists + run helper
  lib/                anthropic tool-loop, mcp-tool conversion, schemas, trace, scenarios
  policy/             deterministic access-policy
  public/index.html   visual SSE console
tests/                policy, operations, tool conversion, routing
```
