# Serval — Multi-Agent IT Orchestrator on Cloudflare

A showcase-quality, **AI-native, multi-agent IT Service Management orchestrator**. A supervisor agent decomposes each request and dispatches scoped specialist agents — **Triage**, **Access-Review**, **Onboarding** — that operate [Serval](https://www.serval.com/)'s system of record over the **Model Context Protocol (MCP)**. Every agent is a Cloudflare **Durable Object**; the whole stack deploys to **Cloudflare Workers**.

| | |
|---|---|
| **Live demo** | https://serval-orchestrator.burademirung.workers.dev |
| **Source** | https://github.com/burademirung/serval |
| **Author** | Vladimir Kamenev · burademirung@gmail.com · (512) 336-9618 |
| **Status** | Built, deployed, and verified live in production |

Open the live URL and click **"Run the fan-out demo"** to watch the supervisor delegate to two specialists in parallel, operate the Serval backend, and synthesize a result — streamed live over Server-Sent Events.

---

## Table of contents
- [What it is](#what-it-is)
- [Architecture](#architecture)
- [The agents](#the-agents)
- [The Serval MCP backend](#the-serval-mcp-backend)
- [Safety: the deterministic policy boundary](#safety-the-deterministic-policy-boundary)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [Setup & run](#setup--run)
- [Deploy to Cloudflare](#deploy-to-cloudflare)
- [Using real Serval](#using-real-serval)
- [Best practices applied](#best-practices-applied)
- [How it was built](#how-it-was-built)
- [Known limitations & deferred work](#known-limitations--deferred-work)
- [Design docs](#design-docs)

---

## What it is

Serval (the product) is an AI-native ITSM platform — its own architecture is multi-agent, which makes a supervisor/specialists orchestrator a natural fit. This project is a **proof of concept** that:

- Demonstrates **real multi-agent orchestration** (dynamic fan-out + synthesis), where each specialist is an independently-addressable, stateful Durable Object.
- Runs **with no real Serval account** against a faithful in-Worker **mock Serval MCP server** (12 tools), and flips to the real Serval MCP server with a single env var.
- Embodies the **June-2026 frontier** of agents, protocol, context engineering, observability, and the Cloudflare edge platform — with every choice justified.
- Ships a **premium visual console** that streams the live orchestration trace.

---

## Architecture

```
        Workers Static Assets  (src/public/index.html — the console)
                 │  GET /                 ← served at the edge
                 │  GET /api/run?scenario=…   (SSE)
                 ▼
        Worker fetch → routeAgentRequest() · /mcp → ServalMCP.serve
                 ▼
   SupervisorAgent  (Durable Object · claude-opus-4-8)
     • plans, applies a simplicity gate, persists its plan
     • delegates via getAgentByName() RPC, parallel Promise.all fan-out
     • synthesizes the final answer with Opus (deterministic fallback)
     • streams an OTel-shaped trace to the browser via SSE
        ├───────────────┬────────────────┬──────────────┐
        ▼               ▼                ▼
   TriageAgent    AccessReviewAgent   OnboardingAgent     (Durable Objects)
   haiku-4-5        sonnet-4-6           sonnet-4-6
     • each runs its OWN Claude tool-loop (@anthropic-ai/sdk via AI Gateway)
     • each scoped to a least-privilege slice of Serval tools
     • returns a distilled, Zod-validated Finding (never a transcript)
        └───────────────┴────────────────┘
                        │  this.mcp client  (RPC transport, no public hop)
                        ▼
              ServalMCP  (McpAgent Durable Object)
                • 12 Serval-faithful tools, stateful seeds
                • public Streamable HTTP at /mcp  ⇄  live Serval by env
```

**Why this shape:** context isolation is the hard part of multi-agent systems. Here it's enforced by the **runtime** — each specialist is a separate Durable Object with its own context window — not by prompt discipline. The supervisor holds only the plan and distilled findings; specialists never leak their raw tool output upward.

### Durable Objects

| DO class (`new_sqlite_classes`) | Binding | Responsibility |
|---|---|---|
| `SupervisorAgent` | `Supervisor` | Plan, gate, delegate (RPC), synthesize, SSE stream |
| `TriageAgent` | `Triage` | Ticket classify / prioritize / reply |
| `AccessReviewAgent` | `AccessReview` | JIT access vs. the deterministic policy |
| `OnboardingAgent` | `Onboarding` | Tickets + access + workflow |
| `ServalMCP` | `ServalMCP` | Mock Serval MCP backend |

---

## The agents

| Agent | Model | Role | Scoped Serval tools |
|---|---|---|---|
| **Supervisor** | `claude-opus-4-8` | Plan · delegate (RPC) · synthesize | *delegation only* |
| **Triage** | `claude-haiku-4-5` | Classify/prioritize tickets, reply | `list_tickets`, `get_ticket`, `update_ticket`, `post_message` |
| **Access-Review** | `claude-sonnet-4-6` | Evaluate JIT access vs. policy | `list_access_requests`, `get_access_request`, `get_user`, `review_access_request` |
| **Onboarding** | `claude-sonnet-4-6` | New-hire: tickets, access, workflow | `get_user`, `create_ticket`, `create_access_request`, `list_workflows`, `run_workflow` |

- **Least privilege is real:** each specialist's tools are filtered to its allowlist *before any tool reaches Claude*. A specialist cannot see — and therefore cannot call — a tool outside its scope.
- **Model IDs live in env vars** (`MODEL_SUPERVISOR`, `MODEL_SONNET`, `MODEL_HAIKU`) so they can be bumped without code changes.
- Each specialist runs a **hand-rolled Claude tool-loop** (`messages.create` → if `stop_reason: tool_use`, execute via the MCP client, append `tool_result`, repeat) and returns a Zod-validated `Finding` (summary + actions + references).

---

## The Serval MCP backend

`ServalMCP` is an `McpAgent` (Durable Object) exposing **12 tools** that mirror Serval's real API shape:

`list_tickets` · `get_ticket` · `update_ticket` · `post_message` · `list_access_requests` · `get_access_request` · `review_access_request` · `create_access_request` · `create_ticket` · `get_user` · `list_workflows` · `run_workflow`

- **MCP spec 2025-11-25:** tools return `structuredContent` alongside text; business/validation errors come back as `{ isError: true }` results (so the agent self-corrects rather than crashing); every tool carries `readOnlyHint` / `destructiveHint` annotations.
- **Stateful seeds** held in Durable Object state: tickets (incl. a sentinel `TCK-ERROR` to exercise the error path), users (incl. one inactive), access requests (incl. one admin/prod-scoped), and one onboarding workflow. Writes are **idempotent** via idempotency keys.
- **Two access paths:** publicly at `/mcp` over Streamable HTTP (point [MCP Inspector](https://github.com/modelcontextprotocol/inspector) or Claude Desktop at it), *and* internally over the Agents SDK v0.6.0 **RPC transport** (`addMcpServer("serval", env.ServalMCP)`) — no public hop, lowest latency.

> **Inspecting state:** the public `/mcp` endpoint and the specialists' RPC transport resolve *different* `ServalMCP` instances, so state you see via the Inspector won't reflect mutations made during an orchestration run. This is expected with the Agents SDK.

---

## Safety: the deterministic policy boundary

The headline claim of an agentic ITSM tool is that it grants access *safely*. We don't trust the model to honor that. The `review_access_request` **tool itself** runs a deterministic policy, so even a jailbroken model cannot approve production or admin access:

```ts
// src/mcp/operations.ts — an agent decision can never be more permissive than policy.
const verdict = decideAccess({ resource, scope, requesterActive, isProduction, isAdmin });
const enforced = RANK[agentDecision] > RANK[verdict.decision];
record(enforced ? verdict.decision : agentDecision);  // policy wins, always
```

`decideAccess()` (`src/policy/access-policy.ts`) returns:
- **approve** — low-risk read for an active user
- **escalate** — admin-level or production grant
- **deny** — inactive requester

It is pure, unit-tested, and the single source of truth.

---

## Tech stack

- **Platform:** Cloudflare Workers + **Durable Objects** + **Static Assets**; `wrangler` (local `wrangler dev` on workerd; `wrangler deploy`).
- **Agents:** `agents@0.6.0` (Cloudflare Agents SDK) — `Agent`, `McpAgent`, `routeAgentRequest`, `getAgentByName`, the `this.mcp` MCP client.
- **MCP:** `@modelcontextprotocol/sdk@1.29.0` (via `agents/mcp`), spec 2025-11-25.
- **LLM:** `@anthropic-ai/sdk@0.40.1` (fetch-based) routed through **Cloudflare AI Gateway** (caching, retries, observability, reconnect buffering). Falls back to calling Anthropic directly when the gateway vars are absent.
- **Validation/tests:** `zod`, `vitest` + `@cloudflare/vitest-pool-workers`.
- **Frontend:** a single self-contained `index.html` (zero build) — Fraunces / Hanken Grotesk / IBM Plex Mono, dark "orchestration control room" theme, live SSE console with `:has()` / container queries / view transitions, all gated behind `prefers-reduced-motion`.

---

## Project layout

```
src/
  index.ts              Worker entry + routing (/, /mcp, /api/run, /agents)
  env.d.ts              augments Env with secret bindings
  mcp/
    serval.ts           ServalMCP McpAgent (registers 12 tools, holds state)
    operations.ts       pure tool operations (unit-tested) + policy enforcement
    seeds.ts            seed store types + factory
  agents/
    supervisor.ts       plan, RPC fan-out, SSE stream, Opus synthesis
    base-specialist.ts  shared Anthropic tool-loop + scoped MCP tools → Finding
    triage.ts / access-review.ts / onboarding.ts   the 3 specialists
    run.ts              scenario → supervisor SSE helper
  lib/
    anthropic.ts        AI-Gateway client + tool-loop runner
    mcp-tools.ts        MCP tool list → Anthropic tools; name normalization
    schemas.ts          Finding / OrchestratorResult / AccessDecision (zod)
    trace.ts            trace event types + SSE encoder
    scenarios.ts        named demo scenarios
  policy/
    access-policy.ts    deterministic decideAccess()
  public/index.html     the premium visual console
tests/                  policy · operations + policy enforcement · tool conversion · routing
docs/superpowers/       design spec (v3) + implementation plan
wrangler.jsonc          5 DO bindings + migration + assets + vars
```

---

## Setup & run

**Requirements:** Node 20+, a Cloudflare account (`wrangler login`), an Anthropic API key. Optionally a Cloudflare AI Gateway (`CF_ACCOUNT_ID`, `GATEWAY_ID`).

```bash
npm install
cp .dev.vars.example .dev.vars        # set ANTHROPIC_API_KEY (AI Gateway vars optional)
npx wrangler types

npm run dev                           # wrangler dev → http://localhost:8787
npm test                              # unit tests
npm run typecheck                     # tsc --noEmit
```

Open `http://localhost:8787/` and click a scenario. Inspect the mock MCP server:
```bash
npx @modelcontextprotocol/inspector       # Transport: Streamable HTTP, URL: http://localhost:8787/mcp
```

**What needs a key:** only the *live* agent runs (Claude calls) need `ANTHROPIC_API_KEY`. Build, typecheck, tests, the `/mcp` server, and the console all work without one. The AI Gateway vars are optional — without them the SDK calls Anthropic directly.

---

## Deploy to Cloudflare

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# optional, to route through AI Gateway:
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put GATEWAY_ID

npx wrangler deploy        # → https://<name>.<subdomain>.workers.dev
```

`wrangler deploy` uploads the Worker, applies the Durable Object migration (creates the 5 SQLite-backed classes on first deploy), and ships the static console. Validate the bundle first with `npx wrangler deploy --dry-run`.

---

## Using real Serval

Set these (as Wrangler secrets / `.dev.vars`):
```bash
SERVAL_MODE=live
SERVAL_MCP_URL=https://public.api.serval.com/mcp/
SERVAL_TOKEN=<your workspace token>
```
The specialists' MCP client then targets the real Serval MCP server instead of the mock binding. Tool names and shapes are identical, so **no agent code changes** are required.

---

## Best practices applied

Researched practices (Anthropic agent & context-engineering guidance, the MCP spec, OpenAI/LangChain operations, the Cloudflare platform), each mapped to a concrete mechanism and verified — see **[docs/BEST_PRACTICES.md](docs/BEST_PRACTICES.md)** for the authoritative, audit-reconciled reference (agent design · orchestration · security · robustness · verification). Highlights:

- **Orchestration:** orchestrator–workers, a 4-field delegation contract, a simplicity gate, effort scaled to complexity, verbatim forwarding.
- **Context engineering:** runtime context isolation (separate DOs), a lean supervisor that holds references not payloads, distilled returns, context-rot defenses, just-in-time data.
- **Tools/MCP:** a faithful mock, structured output, tool annotations, errors-as-results, curated non-overlapping tools.
- **Safety:** the deterministic policy enforced server-side, least-privilege scoping, idempotent writes, secrets never in code/logs/bundle, **all dynamic console fields HTML-escaped** (DOM-XSS hardened).
- **Observability/eval:** OTel-shaped tracing (the console stream), Zod validation at every boundary, end-state evaluation, routing-contract tests, AI Gateway analytics.
- **Model/platform:** tiered models, graceful degradation, mock-now/real-ready, per-run isolation, zero-build edge deploy.

---

## How it was built

1. **Research** — deep, adversarially-verified research on the Serval product & API, the June-2026 agent/context-engineering frontier, MCP, and the Cloudflare platform.
2. **Design** — a full design spec, then **re-platformed** when the Claude Agent SDK proved incompatible with Workers (it spawns a CLI subprocess + needs a filesystem) — onto the Cloudflare Agents SDK, McpAgent, and AI Gateway.
3. **Build** — a phased implementation plan executed **subagent-driven, task-by-task with two-stage review (spec then quality)**; every SDK shape verified against the installed packages.
4. **Review & verify** — a final review fixed three issues (policy enforcement, supervisor synthesis, instance naming); a **live run** then surfaced a bug only the real app could catch (the MCP client tags tools with a generated connection id, not the server name — silently hiding all 12 tools). Fixed, redeployed, verified end-to-end.
5. **Ship** — merged to `master`, deployed to Cloudflare, premium console added, and a DOM-XSS flagged by automated review hardened.

---

## Known limitations & deferred work

Deliberate, documented scope decisions (frontier-aware, not built):

- **Code execution with MCP ("code mode")** — the token-saving pattern for *hundreds* of tools; needs a secure sandbox (Cloudflare Sandbox SDK / Containers). Our ~12 tools are the "direct calls" case. Documented as the scaling path.
- **Cloudflare Workflows / `AgentWorkflow`** — durable, retry/resume orchestration; the PoC uses Supervisor→specialist RPC fan-out (right-sized).
- **Real-time intra-specialist trace** — tool calls are surfaced after each specialist returns (reconstructed from its Finding); a shared `TraceHub` DO / WebSocket relay would stream them live.
- **Human-write-approval endpoint** — a `REQUIRE_WRITE_APPROVAL` + `/api/approve` pause/resume flow; the demo auto-approves writes (the deterministic access policy remains the real safety boundary).
- **OAuth on the mock** — authless for the demo; real Serval uses Bearer.
- **Live Serval mode** — built to spec but verified only against the mock (no workspace credentials).

---

## Documentation

- **[docs/BEST_PRACTICES.md](docs/BEST_PRACTICES.md)** — the authoritative, evidence-based reference: every AI-agent and orchestration best practice mapped to its implementation and verification, plus the full security & robustness posture. Reconciled against the code via two independent audits.
- **[docs/USAGE_AND_DEPLOYMENT.md](docs/USAGE_AND_DEPLOYMENT.md)** — how to use it (console, API, MCP), how to deploy to Cloudflare, and how an organization adopts it against real Serval (front-door channels, Cloudflare Access, rate limiting, cost control, human approval, customization, scaling) — with a production hardening checklist.
- `docs/superpowers/specs/2026-06-01-serval-multi-agent-orchestrator-design.md` — design spec (v3, Cloudflare-native): platform decision record + the full best-practices matrix.
- `docs/superpowers/plans/2026-06-01-serval-multi-agent-orchestrator.md` — the phased, TDD implementation plan with complete code.

---

*Designed & built by **Vladimir Kamenev** — burademirung@gmail.com · (512) 336-9618 · [github.com/burademirung/serval](https://github.com/burademirung/serval)*
