# Serval Multi-Agent IT Orchestrator — Design Spec (v3, Cloudflare-native)

**Date:** 2026-06-01
**Status:** ✅ Implemented & deployed. Live at
https://serval-orchestrator.burademirung.workers.dev · source
https://github.com/burademirung/serval · see `README.md` for run/deploy details.
(v3 — re-platformed onto Cloudflare)
**Author:** Brainstormed with user (vlad@degenito.ai)

> **v3 supersedes v2.** New hard requirement: the whole solution **should deploy on
> Cloudflare**. This invalidated v2's core runtime (the Claude Agent SDK cannot run
> on Workers — it spawns a CLI subprocess and needs a filesystem). v3 re-architects
> onto Cloudflare-native primitives: the **Agents SDK** (agents = Durable Objects),
> **`McpAgent`** for the Serval backend, **`@anthropic-ai/sdk` via AI Gateway** for
> Claude, **Workers Static Assets** + **SSE** for the console. The product intent,
> orchestration model (supervisor + specialists), best practices, the deterministic
> access-policy user contribution, the Conduit-style console, and mock-now/real-ready
> all carry over. v1/v2 are retained in git history.

---

## 1. Purpose & Goal

A **showcase-quality, Cloudflare-deployable, proof-of-concept multi-agent AI
orchestrator** that operates [Serval](https://www.serval.com/)'s ITSM platform
through MCP. A Supervisor agent routes IT work to scoped specialist agents
(Triage, Access-Review, Onboarding); each operates Serval's system of record via
MCP tools; the supervisor synthesizes a unified answer and streams the live
orchestration trace to a visual web console.

Goals:
- Real multi-agent orchestration (dynamic fan-out + synthesis) — **each specialist
  is its own Durable Object**, delegated to via RPC, fanned out in parallel.
- **Deploys on Cloudflare** end-to-end (Workers + Durable Objects + Static Assets;
  `wrangler deploy`).
- Runs **with no real Serval account** via a faithful in-Worker **mock Serval MCP
  server** (`McpAgent`); flips to **real Serval** by env (the specialists' MCP
  client targets the mock binding or the live Serval URL).
- **Showcase of the June-2026 cutting edge** across agents, MCP, context
  engineering, observability, and the Cloudflare platform.
- A **visual representation** (Conduit-style SSE-streamed console) driven by the
  same orchestration core.

### Non-goals (YAGNI)

- No real Serval credentials required for the demo (mock by default).
- No OAuth on the mock MCP server (authless; real Serval uses Bearer).
- No code-execution-with-MCP sandbox (documented scaling path).
- No Cloudflare Containers / Sandbox SDK / Managed Agents (only needed if we kept
  the Claude Agent SDK — we don't).

---

## 2. Background

**Serval** — AI-native ITSM (founded Apr 2024, SF; CEO Jake Stauch, CTO Alex
McLeod; $127M raised, $1B valuation Dec 2025). Exposes a public REST API and an
**MCP server** (`https://public.api.serval.com/mcp/`, Streamable HTTP, OAuth 2.1).
"Every public API endpoint is auto-available as an MCP tool" (`snake_case`). No
public sandbox → we mock it. The mock mirrors Serval's tool surface so agents
behave identically against mock or real Serval. Serval's own architecture is
multi-agent, making this a fitting showcase.

**Why Cloudflare fits:** the reference console the user supplied is itself a Worker;
Cloudflare's Agents SDK + `McpAgent` + Durable Objects are purpose-built for exactly
this (stateful agents, remote MCP servers, streaming) — a stronger platform story
than a local Node process.

---

## 3. Platform decision record (the pivot)

| Concern | v2 (Node) | v3 (Cloudflare) | Why |
|---|---|---|---|
| Agent runtime | Claude Agent SDK (subagents) | **Cloudflare Agents SDK** (`agents`); agents = Durable Objects | Claude Agent SDK spawns a CLI subprocess + needs a filesystem — **cannot run on Workers** |
| Multi-agent | SDK `agents` map + `Agent` tool | **Supervisor DO → specialist DOs via `getAgentByName()` RPC**, parallel `Promise.all` | Idiomatic CF multi-agent; each specialist independently addressable + stateful |
| Serval backend | stdio MCP server | **`McpAgent`** (Durable Object) — Streamable HTTP `/mcp` + internal RPC transport | Workers are HTTP-only; no stdio |
| LLM access | Agent SDK manages model | **`@anthropic-ai/sdk` → AI Gateway**, hand-rolled tool loop | Fetch-based, Workers-compatible; AI Gateway adds caching/retries/observability + reconnect buffering |
| Web/SSE | `node:http` server | **Worker `ReadableStream` SSE** + **Workers Static Assets** | Native to Workers; no duration limit on SSE |
| Tooling | native TS on Node 25 | **Wrangler + workerd** (esbuild bundling) | The Workers toolchain |
| Tests | vitest (node) | **`@cloudflare/vitest-pool-workers`** (+ plain vitest for pure fns) | Runs tests in workerd with DO support |
| Secrets | `--env-file=.env` | **`.dev.vars`** / `wrangler secret put` | Workers secret model |

**Forced "won't work on Workers" list (designed around):** `@anthropic-ai/claude-agent-sdk`; stdio transport; `node:http`; native-TS type-stripping. **AI-SDK footgun avoided** (n/a — we use `@anthropic-ai/sdk`). **Agent DO classes MUST be in `new_sqlite_classes` migrations** and `compatibility_flags: ["nodejs_compat"]` is required.

---

## 4. Architecture

```
        Workers Static Assets  (src/public/index.html, SPA)
                 │  GET /            ← served before the Worker
                 │  GET /api/run?scenario=…  (SSE)
                 ▼
        ┌──────────────── Worker (default fetch) ───────────────┐
        │  routeAgentRequest()  ·  /mcp → ServalMCP.serve        │
        │  /api/run → SupervisorAgent (SSE)                      │
        └───────────────────────┬───────────────────────────────┘
                                ▼
              SupervisorAgent  (Durable Object, claude-opus-4-8)
                • plans + simplicity-gates + synthesizes
                • streams OTel-style trace to the browser via SSE
                • getAgentByName() RPC → specialists, Promise.all fan-out
            ┌───────────────┬───────┴────────┬───────────────┐
            ▼               ▼                ▼
     TriageAgent     AccessReviewAgent   OnboardingAgent   (Durable Objects)
   haiku-4-5           sonnet-4-6           sonnet-4-6
     • each runs its OWN Anthropic Messages tool-loop (via AI Gateway)
     • each scoped to its slice of Serval MCP tools (least privilege)
     • returns a distilled, schema-validated Finding (no transcripts)
            └───────────────┴────────────────┘
                            │  this.mcp client  (RPC transport, no public hop)
                            ▼
                  ServalMCP  (McpAgent Durable Object)
                    • 12 Serval-faithful tools (inputSchema + outputSchema +
                      structuredContent + annotations + isError)
                    • mock seeds in DO state
                    • ALSO public at /mcp (Streamable HTTP) for Inspector/Claude
                            │
              real-ready:  SERVAL_MODE=live → specialists' MCP client targets
              https://public.api.serval.com/mcp/ (Bearer) instead of the binding
```

### Worker / Durable Object inventory

| DO class (`new_sqlite_classes`) | Binding | Responsibility |
|---|---|---|
| `SupervisorAgent` | `Supervisor` | Plan, gate, delegate (RPC), synthesize, SSE stream |
| `TriageAgent` | `Triage` | Ticket classify/prioritize/reply (haiku) |
| `AccessReviewAgent` | `AccessReview` | JIT access vs deterministic policy (sonnet) |
| `OnboardingAgent` | `Onboarding` | Tickets + access + workflow (sonnet) |
| `ServalMCP` | `ServalMCP` | Mock Serval MCP backend (McpAgent) |

---

## 5. Source layout

```
serval-orchestrator/
├── wrangler.jsonc                 # Worker config: 5 DO bindings + migrations + assets + AI Gateway vars
├── package.json                   # deps: agents, @modelcontextprotocol/sdk, @anthropic-ai/sdk, zod
├── tsconfig.json                  # extends "agents/tsconfig" (NO experimentalDecorators)
├── vitest.config.ts               # @cloudflare/vitest-pool-workers
├── .dev.vars.example              # ANTHROPIC_API_KEY, CF_ACCOUNT_ID, GATEWAY_ID, SERVAL_MODE, model IDs
├── worker-configuration.d.ts      # generated by `wrangler types`
├── src/
│   ├── index.ts                   # Worker entry: routes (assets / /api/run / /mcp / /agents)
│   ├── mcp/
│   │   ├── serval.ts              # ServalMCP extends McpAgent — registers 12 tools
│   │   └── seeds.ts               # in-memory seed shapes + factory
│   ├── agents/
│   │   ├── supervisor.ts          # SupervisorAgent: plan, gate, fan-out RPC, SSE, synthesize
│   │   ├── triage.ts              # TriageAgent
│   │   ├── access-review.ts       # AccessReviewAgent (uses the policy)
│   │   ├── onboarding.ts          # OnboardingAgent
│   │   └── base-specialist.ts     # shared: Anthropic tool-loop + scoped MCP tools + Finding
│   ├── lib/
│   │   ├── anthropic.ts           # AI-Gateway-routed Anthropic client + tool-loop runner
│   │   ├── mcp-tools.ts           # MCP tool list → Anthropic tools; callTool wrapper
│   │   ├── schemas.ts             # zod: Finding, OrchestratorResult, AccessDecision
│   │   ├── trace.ts               # OTel-GenAI-shaped trace event types + SSE encoder
│   │   └── scenarios.ts           # named demo scenarios
│   ├── policy/
│   │   └── access-policy.ts       # ← USER contribution: deterministic decideAccess()
│   └── public/
│       └── index.html             # Conduit-style visual console (SSE client)
└── tests/
    ├── policy.test.ts             # pure unit tests for decideAccess (pre-written)
    ├── mcp-tools.test.ts          # MCP→Anthropic tool conversion, callTool wrapper
    ├── serval-mcp.test.ts         # McpAgent tools via vitest-pool-workers (Streamable HTTP)
    └── eval/scenarios.eval.ts     # gated end-state evals (RUN_EVALS)
```

> **NOTE (as-built):** as-built files differ — src/mcp/operations.ts was added; tests are tests/mcp-tools.test.ts (not serval-mcp.test.ts) and tests/eval/scenarios.test.ts (not scenarios.eval.ts).

---

## 6. Agents, models & tool scoping (least privilege)

| Agent (DO) | Model (env-configurable) | Role | Serval tools it may call |
|---|---|---|---|
| **Supervisor** | `claude-opus-4-8` | Plan, delegate (RPC), synthesize; streams SSE | *(none direct — delegates only)* |
| **Triage** | `claude-haiku-4-5` | Classify/prioritize tickets, reply | `list_tickets`, `get_ticket`, `update_ticket`, `post_message` |
| **Access-Review** | `claude-sonnet-4-6` | Evaluate JIT access vs policy | `list_access_requests`, `get_access_request`, `get_user`, `review_access_request` |
| **Onboarding** | `claude-sonnet-4-6` | New-hire: tickets + access + workflow | `create_ticket`, `create_access_request`, `list_workflows`, `run_workflow`, `get_user` |

- **Model IDs live in env vars** (`MODEL_SUPERVISOR`, `MODEL_SONNET`, `MODEL_HAIKU`)
  — Cloudflare docs still referenced older IDs, so the exact 2026 strings are
  bumpable without code changes. Defaults: opus 4.8 / sonnet 4.6 / haiku 4.5.
- **Least privilege:** each specialist filters `this.mcp` tools down to its allowed
  slice before passing them to Claude. A specialist literally cannot call a tool
  outside its set.
- **Anthropic-native knobs:** `effort` (supervisor `xhigh`, specialists `high`) and
  adaptive thinking passed through `@anthropic-ai/sdk` where supported (feature-flag
  guarded; degrade gracefully if the gateway/model rejects them).

> **NOTE (as-built):** effort is a single optional env var (CLAUDE_EFFORT) applied uniformly and off by default; per-agent effort levels were not implemented.

---

## 7. Orchestration flow

1. Browser hits `GET /api/run?scenario=fanout` → routed to a `SupervisorAgent`
   instance, which returns an **SSE `ReadableStream`**.
2. Supervisor emits `run_start`, **persists its plan** to DO state, applies the
   **simplicity gate** (1 specialist for single-domain; fan out only when the
   request spans domains), scaling effort to complexity.
3. For each chosen specialist, the supervisor emits `delegate` then calls it via
   **`getAgentByName(env.Triage, id).run(taskSpec)`**. The `taskSpec` carries the
   **4-field contract** (objective, output format, tools/sources, boundaries).
   Multiple specialists run in **parallel** (`Promise.all`).
4. Each **specialist DO** runs its own Anthropic tool-loop against its scoped Serval
   MCP tools (RPC to `ServalMCP`), and returns a **distilled, Zod-validated
   `Finding`** (summary + actions + references) — never its transcript.
5. The supervisor streams each specialist's `actions` as `tool_call`/`tool_result`
   trace events (reconstructed from the returned Finding), then `synthesis`.
6. The supervisor synthesizes a final `OrchestratorResult` (optionally a final
   Claude call) and emits `done` with the answer. Writes are **idempotent**
   (idempotency keys), safe under Workflows/RPC retry.

**Worked example** — `GET /api/run?scenario=fanout` →
"Onboard Jane Doe and review her pending access requests." → supervisor fans out to
**Onboarding** + **Access-Review** in parallel, streams both pipelines, merges into
one attributed answer.

**Live-trace fidelity note:** intra-specialist tool calls are surfaced after each
specialist returns (reconstructed from `Finding.actions`). A future upgrade (a
shared `TraceHub` Durable Object or WebSocket relay) would stream them in real time;
deferred for the PoC (§14).

---

## 8. Serval MCP backend (`ServalMCP` McpAgent)

- Extends `McpAgent`; `server = new McpServer({name:"serval",version})`; registers
  **12 tools** in `init()` via `server.registerTool(name, {description, inputSchema,
  outputSchema, annotations}, handler)`.

> **NOTE (as-built):** outputSchema is not registered; tools return structuredContent, validated client-side with Zod.
- **MCP spec 2025-11-25:** handlers return `content` (JSON text, back-compat) **and**
  `structuredContent` (validated against `outputSchema`); business/validation errors
  as `{ isError: true }` (not thrown); **annotations** (`readOnlyHint` on reads;
  `destructiveHint`/`idempotentHint` on writes); resource links for any large payload.
- **Seeds** in DO state (tickets incl. a sentinel error id, users incl. one inactive,
  access requests incl. one admin/prod-scoped, one onboarding workflow). Writes
  mutate DO state and are idempotent by `idempotencyKey`.
- **Exposure:** `ServalMCP.serve("/mcp")` for public Streamable HTTP (Inspector /
  Claude Desktop / Anthropic connector); **and** reachable internally by specialists
  via the **v0.6.0 RPC transport** (`addMcpServer("serval", env.ServalMCP)`) — no
  public hop, lowest latency.
- **Authless** (mock). Real Serval uses Bearer (handled in the connection swap).

### Real-ready swap

A specialist connects its MCP client by env:
- `SERVAL_MODE=mock` (default): `addMcpServer("serval", env.ServalMCP)` (RPC binding).
- `SERVAL_MODE=live`: `addMcpServer("serval", env.SERVAL_MCP_URL, { transport: { headers: { Authorization: "Bearer " + env.SERVAL_TOKEN } } })`.
Tool names/shapes are identical, so specialist logic is unchanged.

---

## 9. Best practices implemented (carried over + Cloudflare-mapped)

All 40 from v2 still apply; the platform-specific mapping:

**Orchestration & context engineering**
- Orchestrator-workers via **DO RPC fan-out**; 4-field delegation contract in the
  `taskSpec`; simplicity gate + effort scaling in the supervisor prompt at the right
  altitude; **context isolation enforced by separate DOs** (specialists return
  distilled Findings, not transcripts); lean supervisor holds references only;
  context-rot defenses (critical instructions at prompt edges, distractor filtering).

**Tools / MCP**
- Faithful mock; `outputSchema` + `structuredContent`; `readOnly`/`destructive`
  annotations; `isError` not throw; resource links; curated non-overlapping
  per-specialist tool slices.

**Safety / security**
- **Deterministic access policy** (`decideAccess`) is the real safety boundary —
  Access-Review must defer to it. Least-privilege tool scoping. Idempotent writes.
  Mock is authless by design; real Serval Bearer kept in a Worker **secret**.
  Tool-definition awareness (annotations treated as untrusted hints).
- **Write guarding:** writes are flagged + traced; `REQUIRE_WRITE_APPROVAL` env can
  pause for human approval via DO state + a `/api/approve` endpoint (auto-approve in
  the demo). (HITL-on-Workers replacement for the v2 stdin gate.)

**Structured output, observability, eval, model controls**
- Findings + final result validated with **Zod**; supervisor synthesis uses a
  structured result schema. **OTel-GenAI-shaped trace** (one `trace_id` per run;
  `invoke_agent`/`execute_tool`/`mcp` events) streamed over SSE and visible in
  **AI Gateway** analytics. End-state evals (gated). **AI Gateway** provides
  caching, retries, cost tracking, and mid-inference reconnect. Per-agent model
  tiers; `effort`/adaptive thinking where supported; env-bumpable model IDs.

> **NOTE (as-built):** event names are custom (run_start/delegate/tool_call/tool_result/synthesis/done/error) with a camelCase traceId per run — inspired by OTel-GenAI, not spec-compliant.

**Cloudflare-native correctness (must-follow)**
- `compatibility_flags: ["nodejs_compat"]`; all agent/McpAgent classes in
  **`new_sqlite_classes`** migrations (new tag for new classes; never edit old tags);
  do **not** enable `experimentalDecorators` (breaks `@callable`) — extend
  `agents/tsconfig`; access secrets via `this.env`, never `process.env`; run
  `wrangler types` after editing `wrangler.jsonc`.

---

## 10. The Anthropic tool-loop (per specialist)

`src/lib/anthropic.ts` + `src/lib/mcp-tools.ts` provide a reusable runner used by
`base-specialist.ts`:

1. Build the Anthropic client: `new Anthropic({ apiKey: env.ANTHROPIC_API_KEY,
   baseURL: \`https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.GATEWAY_ID}/anthropic\` })`.
2. Convert the specialist's **scoped** MCP tools (from `this.mcp.listTools()`,
   filtered to its allowlist) → Anthropic `tools` (`name`, `description`,
   `input_schema` from the MCP `inputSchema`).
3. Loop: `messages.create({ model, max_tokens, tools, messages, ...effort })`.
   While `stop_reason === "tool_use"`: for each `tool_use` block, call
   `this.mcp.callTool(...)`, append a `tool_result` (carry `isError` through),
   record an action for the Finding, repeat. Cap iterations (`maxSteps`) as the
   stopping condition.
4. Parse the final assistant message's fenced JSON into a `Finding` (Zod-validate;
   on failure, one re-ask). Return the `Finding`.

> SDK-shape note: `this.mcp` method names (`listTools`/`callTool`/`getAITools`) and
> the `@anthropic-ai/sdk` tool-loop fields follow June-2026 research; verify against
> the installed `agents` + `@anthropic-ai/sdk` versions and adjust in these two files
> only — the rest of the system is insulated.

---

## 11. User contribution (learning mode)

`src/policy/access-policy.ts` — unchanged from v2: a pure `decideAccess(ctx)` →
`{ decision: "approve"|"deny"|"escalate", reason }` (union type, not a TS enum). The
scaffold ships the file, types, doc comment, TODO, and a pre-written
`tests/policy.test.ts`. The **user writes the ~8-line body**. The Access-Review agent
calls this function and must respect its verdict (LLM does not self-approve).

---

## 12. Visual representation (Conduit-style console)

Single static `src/public/index.html`, served by **Workers Static Assets**
(`assets` binding, SPA fallback). It is a **second consumer of the same supervisor**:
a scenario button opens an `EventSource` to `GET /api/run?scenario=…`; the supervisor
streams the live trace; the page renders an animated agent/tool pipeline + log.

Sections (per the reference): hero · live demo console (scenario buttons:
Triage / Review access / Onboard / **Fan-out**) · ASCII architecture diagram · agent
registry table · cutting-edge stack grid · best-practices grid · **mock-vs-live +
Cloudflare topology** (Worker, DOs, McpAgent, AI Gateway) · status/roadmap · footer.

Style: white/charcoal/teal; **Bricolage Grotesque / Hanken Grotesk / IBM Plex Mono**
(Google Fonts via `<link>`); flat bordered, no shadows; **`:has()` / container
queries / view transitions**; `prefers-reduced-motion`; `aria-live` log. Zero build
for the page (vanilla HTML/CSS/JS).

SSE event names: `run_start`, `delegate`, `tool_call`, `tool_result`, `synthesis`,
`done`, `error` — emitted from the supervisor's `ReadableStream`.

---

## 13. Tech stack

- **Platform:** Cloudflare Workers + **Durable Objects** + **Static Assets**;
  `wrangler` (local `wrangler dev` on workerd; deploy `wrangler deploy`).
- **Agents:** `agents` (Cloudflare Agents SDK) — `Agent`, `McpAgent`,
  `routeAgentRequest`, `getAgentByName`, `this.mcp` MCP client.
- **MCP server:** `@modelcontextprotocol/sdk` v1.x (via `agents/mcp`), spec 2025-11-25.
- **LLM:** `@anthropic-ai/sdk` (fetch-based) routed through **AI Gateway**.
- **Validation:** `zod`.
- **Language:** TypeScript, ESM; `tsconfig` extends `agents/tsconfig` (no
  `experimentalDecorators`). Bundled by wrangler/esbuild (no native-TS constraint).
- **Tests:** `@cloudflare/vitest-pool-workers` (DO-aware integration) + plain
  `vitest` for pure functions; evals gated by `RUN_EVALS`.
- **Secrets/vars:** `.dev.vars` locally; `wrangler secret put ANTHROPIC_API_KEY`
  (and `SERVAL_TOKEN` for live) in prod. `wrangler types` for `Env`.
- **Config:** `wrangler.jsonc` — `compatibility_flags: ["nodejs_compat"]`, 5 DO
  bindings, one migration (`new_sqlite_classes`), `assets`, `observability`,
  AI-Gateway env (`CF_ACCOUNT_ID`, `GATEWAY_ID`), model-ID env vars.

---

## 14. Scope decisions & deferred frontier options

- **Code execution with MCP ("code mode")** — deferred (needs a sandbox; ~12 tools is
  the "direct calls" case). On Cloudflare the sandbox would be the **Sandbox SDK /
  Containers**; documented scaling path.
- **Cloudflare Workflows / `AgentWorkflow`** — durable, retry/resume orchestration
  (wrap each specialist call in `step.do()`). Deferred; the PoC uses Supervisor→
  specialist RPC fan-out (right-sized). Documented as the durability upgrade.
- **Real-time intra-specialist trace** — a shared `TraceHub` DO / WebSocket relay to
  stream tool calls live (vs. reconstructed-from-Finding). Deferred (§7).
- **Human-write-approval endpoint** — `REQUIRE_WRITE_APPROVAL` + `/api/approve`
  pause/resume via DO state. Designed; demo auto-approves.
- **OAuth on the mock** — `@cloudflare/workers-oauth-provider` (authless for now).
- **MCP `2026-07-28` RC / SDK v2** — tracked, not adopted (pre-final/alpha).

---

## 15. Open risks / caveats

- **Token cost:** multi-agent ≈ 15× a single chat; mitigated by tiered models,
  effort/step caps, the simplicity gate, **AI Gateway caching**, and tool scoping.
- **SDK churn:** `agents`, `@anthropic-ai/sdk`, and the MCP spec evolve fast; pin
  versions; insulate SDK-shape assumptions to `lib/anthropic.ts` + `lib/mcp-tools.ts`.
- **Model IDs:** keep in env vars; verify exact 2026 strings at deploy.
- **DO migration discipline:** agent classes must be `new_sqlite_classes`; adding
  classes later needs a new migration tag.
- **Live mode unverified:** real Serval MCP can't be tested without a workspace; the
  swap is built to spec, verified only against the mock.
- **Live-trace fidelity:** intra-specialist calls are reconstructed post-return, not
  streamed live (deferred upgrade).
- **Supervisor fidelity ("telephone game"):** mitigated by forwarding specialist
  Finding summaries verbatim where it matters.
</content>
