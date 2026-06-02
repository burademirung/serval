# Usage, Deployment & Organizational Adoption

How to **use** the orchestrator, how to **deploy** it to Cloudflare, and how an **organization** would run it against real Serval as part of its IT operations.

- [1. What it does and who uses it](#1-what-it-does-and-who-uses-it)
- [2. How to use it](#2-how-to-use-it)
- [3. How to deploy it](#3-how-to-deploy-it)
- [4. Using it in an organization](#4-using-it-in-an-organization)
- [5. Production hardening checklist](#5-production-hardening-checklist)
- [6. Request lifecycle (end to end)](#6-request-lifecycle-end-to-end)

---

## 1. What it does and who uses it

The orchestrator turns a **plain-language IT request** into coordinated action across an ITSM system of record (Serval), via specialist AI agents:

- **End users / employees** — submit requests ("onboard Jane Doe", "I need GitHub access", "my VPN is down"). They never see the agents; they see resolutions.
- **IT / IT-ops teams** — own the agents, the tool scopes, and the access policy; watch the live trace; review escalations.
- **Platform/SRE** — own the Cloudflare deployment, secrets, rate limits, and observability.

It is an **AI control plane in front of Serval**: the Supervisor decides which specialists are needed, each specialist operates Serval over MCP within a least-privilege scope, and a deterministic policy guards access decisions.

---

## 2. How to use it

There are three surfaces. All are served by the one Cloudflare Worker.

### a) The web console (`/`)
The fastest way to see it work. Open the deployment URL and click a scenario:
- **Triage tickets** — classify/prioritize open tickets and reply to the top one.
- **Review access** — evaluate pending just-in-time access requests against policy.
- **Onboard employee** — create the onboarding ticket, request baseline access, run the workflow.
- **Fan-out** — onboard *and* review access in parallel.

The trace streams live: which specialists the supervisor routed to, every tool call, and the synthesized answer.

### b) The orchestration API (`/api/run`)
Server-Sent Events. Drive it from any client:
```bash
curl -N "https://<your-worker>/api/run?scenario=fanout"
```
Events: `run_start`, `delegate`, `tool_call`, `tool_result`, `synthesis`, `done` (carries the final `answer` + structured `findings`), `error`. Every event carries a per-run `traceId`.

To support **free-form requests** (not just the named scenarios), extend `src/lib/scenarios.ts` or add a route that passes an arbitrary `prompt` to `SupervisorAgent.stream(prompt, fallbackSpecialists)` — the supervisor already routes dynamically from the prompt text, so the specialist set is chosen for you.

### c) The Serval MCP server (`/mcp`)
The mock (or, in live mode, real Serval) is exposed as a standard **Streamable HTTP MCP server**. Point any MCP client at it:
```bash
npx @modelcontextprotocol/inspector     # Transport: Streamable HTTP · URL: https://<your-worker>/mcp
```
Claude Desktop, the Anthropic Messages API `mcp_servers` connector, or your own agent can call the 12 tools directly. (Reads are safe to expose; gate writes in production — see §5.)

---

## 3. How to deploy it

### Prerequisites
- Node 20+, a Cloudflare account (`npx wrangler login`)
- An Anthropic API key (`sk-ant-…`)
- *(Optional)* a Cloudflare AI Gateway (`CF_ACCOUNT_ID`, `GATEWAY_ID`) for caching/retries/observability

### Local
```bash
npm install
cp .dev.vars.example .dev.vars      # set ANTHROPIC_API_KEY (AI Gateway vars optional)
npx wrangler types
npm run dev                         # http://localhost:8787
```

### Deploy to Cloudflare
```bash
npx wrangler secret put ANTHROPIC_API_KEY
# optional (AI Gateway):
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put GATEWAY_ID
# optional (lock down the public endpoints):
npx wrangler secret put PUBLIC_ACCESS_TOKEN

npx wrangler deploy                 # → https://<name>.<subdomain>.workers.dev
```
`wrangler deploy` uploads the Worker, applies the Durable Object migration (creates the 5 SQLite-backed classes on first deploy), and ships the static console. Add a **custom domain** in the Cloudflare dashboard (Workers → your worker → Triggers → Custom Domains).

### Environment & secrets reference
| Name | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | Required for live agent runs |
| `CF_ACCOUNT_ID`, `GATEWAY_ID` | secret | Route Claude through AI Gateway (optional) |
| `SERVAL_MODE` | var | `mock` (default) or `live` |
| `SERVAL_MCP_URL`, `SERVAL_TOKEN` | secret | Real Serval endpoint + token (live mode) |
| `MODEL_SUPERVISOR`/`MODEL_SONNET`/`MODEL_HAIKU` | var | Model IDs (bumpable without code) |
| `PUBLIC_ACCESS_TOKEN` | secret | Optional bearer gate on `/mcp` + `/api/run` |
| `CLAUDE_EFFORT` | var | Optional reasoning effort (off by default) |

---

## 4. Using it in an organization

### Step 1 — Point it at real Serval
Set `SERVAL_MODE=live`, `SERVAL_MCP_URL=https://public.api.serval.com/mcp/`, and `SERVAL_TOKEN=<workspace token>` (Wrangler secrets). The specialists' MCP client now targets your real Serval workspace. **Tool names and shapes are identical to the mock, so no agent code changes are needed.** Start with read-only scenarios to validate before enabling writes.

### Step 2 — Decide how requests enter ("the front door")
Today, requests arrive via the console or `/api/run`. In an organization you'll typically wire one or more channels to `/api/run` (or to a thin handler that calls `SupervisorAgent.stream(prompt, …)`):
- **Chat** — a Slack/Teams slash command or bot posts the user's message as the `prompt`.
- **Email / help desk** — an inbound webhook turns a ticket/email body into a `prompt`.
- **Serval's own surfaces** — since Serval already fronts Slack/email/web, you can run this orchestrator behind those and let it operate the record.

### Step 3 — Authenticate organizational users
Put **Cloudflare Access** (SSO via your IdP — Okta, Google, Entra) in front of the Worker so only authenticated employees reach `/` and `/api/run`. This is stronger than the built-in `PUBLIC_ACCESS_TOKEN` and gives you per-user identity for auditing. Pass the authenticated identity into the request so the access policy can use the *real* requester.

### Step 4 — Govern access decisions
The deterministic policy (`src/policy/access-policy.ts`) is your control point. Tailor it to your org: which scopes auto-approve, what always escalates (admin, production, regulated systems), and how inactive/contractor accounts are handled. It is enforced inside the `review_access_request` tool, so the model cannot override it. For high-stakes grants, enable the **human-approval** pattern (`REQUIRE_WRITE_APPROVAL` + an `/api/approve` endpoint) so a person confirms before the write commits.

### Step 5 — Control cost and load
- **AI Gateway** — route Claude through it for caching, automatic retries, per-model cost tracking, and analytics.
- **Rate limiting** — add a Cloudflare Rate Limiting rule (e.g. keyed on `cf.connecting_ip` or the Access identity) on `/api/run` and `/mcp` so a loop can't run up LLM or DO costs.
- **Model tiers** — keep Haiku/Sonnet on the leaves and Opus only where it matters; the model IDs are env vars.
- **`maxBudgetUsd`/effort** — tune `CLAUDE_EFFORT` and step caps to your budget.

### Step 6 — Observe and evaluate
- Each run emits a `traceId`-tagged event stream; pipe it to your logging/observability sink.
- Cloudflare **Workers observability** is enabled in `wrangler.jsonc`; **AI Gateway** gives model-level analytics.
- Extend `tests/eval/` with end-state evals (LLM-as-judge on the final Serval state) and gate deploys on them.

### Step 7 — Customize the agents
- **Scopes** — edit each specialist's `allow` list (`src/agents/*.ts`) to match the tools your org permits.
- **New specialists** — add an `Agent` class + a Durable Object binding/migration in `wrangler.jsonc`, register it in the supervisor's `stubs` and `ALL_SPECS`, and the router will consider it.
- **More tools** — add them to `ServalMCP` (mock) or rely on real Serval's full tool surface in live mode.

### Scaling
Each agent is a **Durable Object** — they hibernate when idle and scale horizontally across Cloudflare's network. The supervisor is keyed per run; specialists get fresh per-run instances. There is no server to manage; cost scales with use (DO + LLM).

---

## 5. Production hardening checklist

Before running publicly with a funded API key against real data:

- [ ] **Auth** — Cloudflare Access (SSO) in front of `/` and `/api/run`; or set `PUBLIC_ACCESS_TOKEN`.
- [ ] **Gate `/mcp` writes** — require auth, or only expose read tools publicly, or rate-limit.
- [ ] **Rate limiting** — Cloudflare Rate Limiting rule on `/api/run` and `/mcp` (cost-DoS defense).
- [ ] **Secrets** — all keys via `wrangler secret put` (never in `wrangler.jsonc` or code); confirm `.dev.vars` stays gitignored.
- [ ] **Human-in-the-loop** — enable write approval for high-stakes actions.
- [ ] **Access policy** — review `decideAccess()` against your real access-governance rules.
- [ ] **Real-requester identity** — wire the authenticated user into the access context (don't trust LLM-asserted identity).
- [ ] **Observability** — ship traces to your sink; enable AI Gateway analytics.
- [ ] **Evals** — add end-state evals and gate deploys.
- [ ] **Live-mode validation** — exercise real Serval read-only first, then writes, in a non-prod workspace.

The system is **secure-by-configuration**: the mechanisms (auth gate, fail-safe live switch, deterministic policy, least privilege, escaping, bounded loops) are in place; production deployment is about turning the optional gates on and pointing them at your IdP and rate-limit rules.

---

## 6. Request lifecycle (end to end)

> *"Onboard Jane Doe and review her pending access requests."*

1. **Entry** — the request arrives at `/api/run` (from the console, chat, or help desk), authenticated via Cloudflare Access.
2. **Route** — the `SupervisorAgent` (Durable Object) asks the supervisor model which specialists are needed → `[onboarding, access-review]` (it spans domains).
3. **Fan-out** — both specialists run in parallel as separate Durable Objects, each connecting to Serval over MCP with its own least-privilege tool scope.
4. **Act** — Onboarding looks up Jane, creates the onboarding ticket, requests baseline access, runs the workflow (idempotent). Access-Review evaluates each pending request; the `review_access_request` tool runs `decideAccess()` and **enforces** the verdict (admin/prod → escalate), regardless of what the model decides.
5. **Distill** — each specialist returns a validated `Finding` (summary + actions + references), not its transcript.
6. **Synthesize** — the supervisor (Opus) merges the findings into one answer (deterministic fallback if the model call fails).
7. **Stream & record** — every step is emitted as a `traceId`-tagged SSE event to the caller and your observability sink; the final answer + structured findings are returned.

Throughout, the agents are bounded (step caps, one-level delegation), errors are contained (the stream always closes cleanly), and access decisions are governed by code, not by the model.

---

*See also: `README.md`, `docs/BEST_PRACTICES.md`, and `docs/superpowers/` for the design spec and implementation plan.*
