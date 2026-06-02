# Serval Multi-Agent IT Orchestrator — Design Spec (v2, cutting-edge)

**Date:** 2026-06-01
**Status:** Approved design, pre-implementation (v2 — hardened with June-2026 research)
**Author:** Brainstormed with user (vlad@degenito.ai)

> v2 incorporates a second, deeper research pass targeting the **June-2026 state of
> the art**: current Claude model IDs + `effort`, the Agent SDK's native structured
> outputs / compaction / memory / tool-search, MCP spec `2025-11-25`, context
> engineering, OpenTelemetry GenAI observability, and zero-build native-TypeScript
> Node tooling. Every applicable best practice is mapped to an implementation in §8.

---

## 1. Purpose & Goal

Build a **showcase-quality, proof-of-concept multi-agent AI orchestrator** that
operates against [Serval](https://www.serval.com/)'s ITSM platform through its
Model Context Protocol (MCP) interface, demonstrating **supervisor + specialists
orchestration** on the current technology frontier.

An Orchestrator agent routes each request to scoped specialist agents (Triage,
Access-Review, Onboarding), each acting on Serval's system of record via MCP
tools, then synthesizes a unified answer.

The PoC must:

- Demonstrate real multi-agent orchestration (dynamic fan-out + synthesis), not a
  single conversational agent.
- Run **immediately with no Serval account** via a faithful in-memory mock MCP
  backend, and flip to the **real Serval MCP server** with only an env/credential
  change ("mock now, real-ready").
- **Embody the June-2026 cutting edge** of agent implementation, orchestration,
  context engineering, observability, and tooling (this is an explicit goal — the
  project is a showcase of state-of-the-art technologies).
- Include a **visual representation** (a Conduit-style streaming demo web console)
  driven by the same orchestration core (§13).

### Non-goals (YAGNI)

- No production deployment, hosted auth server, or persistence beyond in-memory +
  local memory files.
- No real Serval credentials required to run the demo.
- No code-execution-with-MCP sandbox (documented as the scaling path in §17, not
  built — see rationale there).
- No live Serval calls from the browser demo (mock only) so it always runs.

---

## 2. Background: Serval & its API (researched)

Serval is an AI-native ITSM platform (founded April 2024, San Francisco; CEO Jake
Stauch, CTO Alex McLeod; $127M raised, $1B valuation Dec 2025). Its own
architecture is multi-agent (Help Desk Agent + Automation/Builder Agent), which
makes a multi-agent orchestrator a natural showcase.

Serval exposes a **public REST API** and an **MCP server**:

- REST base: `https://public.api.serval.com/v2/`
- MCP endpoint: `https://public.api.serval.com/mcp/` (Streamable HTTP transport)
- Auth: OAuth2 client-credentials (REST) / OAuth 2.1 browser flow (MCP). API
  credentials come from the workspace admin dashboard. **No public sandbox
  exists** — hence the mock.
- MCP design: "every public API endpoint is automatically available as an MCP
  tool"; `snake_case` tools (`list_tickets`, `create_ticket`, `get_user`,
  `list_workflows`, …); same permissions/rate-limits as REST.

The mock mirrors this tool surface so agents behave identically against mock or
real Serval.

---

## 3. Cutting-edge technology showcase

The frontier stack this PoC demonstrates (verified June 2026):

| Layer | Technology / pattern | Why it's state of the art |
|---|---|---|
| Models | **Claude Opus 4.8** (`claude-opus-4-8`) orchestrator, **Sonnet 4.6** (`claude-sonnet-4-6`) + **Haiku 4.5** (`claude-haiku-4-5`) specialists | Latest tier; mixed-tier orchestration (strong supervisor, cheap leaves) |
| Reasoning | **Adaptive thinking** + **`effort`** knob (`xhigh` orchestrator) | 2026 replacement for manual `budget_tokens` (400s on Opus 4.8) |
| Agent runtime | **`@anthropic-ai/claude-agent-sdk`** programmatic subagents | Current Agent SDK; isolated-context delegation |
| Structured output | SDK **`outputFormat` (JSON schema)** + auto re-prompt | Guaranteed-valid specialist results, no manual parsing |
| Context | **Automatic compaction** + **memory tool** + context editing | Long-horizon reliability; mitigates context rot |
| Protocol | **MCP spec `2025-11-25`** (`outputSchema`/`structuredContent`, resource links, refined error semantics) | Newest stable MCP revision |
| Cost/resilience | `fallbackModel`, `maxBudgetUsd`, per-agent `maxTurns`, prompt caching | Production cost + failure controls |
| Observability | **OpenTelemetry GenAI semantic conventions** (one `trace_id` per run) | 2026 standard for agent tracing |
| Tooling | **Native TypeScript on Node 25** (type stripping, zero build step) | No tsx/dotenv/nodemon/bundler — Node-native |
| Web demo | **SSE over `node:http`** + **`:has()` / container queries / view transitions** | Zero-build modern UI, Baseline-2026 CSS |

---

## 4. Architecture

```
        ┌──────────────┐
        │ Orchestrator │  claude-opus-4-8, effort=xhigh, permissionMode=default
        │  (LEAN)      │  - holds plan + references only, never raw specialist output
        │  routes +    │  - gates multi-agent behind a complexity heuristic
        │  synthesizes │  - delegates via Agent tool with the 4-field contract
        └──────┬───────┘
     ┌─────────┼──────────┐
     ▼         ▼          ▼
 ┌───────┐ ┌────────┐ ┌──────────┐
 │Triage │ │Access  │ │Onboarding│   AgentDefinition specialists (isolated context,
 │haiku  │ │Review  │ │ sonnet   │   scoped MCP tools, outputFormat=Zod schema,
 │ 4.5   │ │sonnet  │ │  4.6     │   maxTurns cap). Return distilled findings only.
 └───┬───┘ └───┬────┘ └────┬─────┘
     └─────────┼───────────┘
               ▼
   ┌────────────────────────┐   MCP (stdio mock now / Streamable HTTP+Bearer live)
   │  Serval MCP backend     │   spec 2025-11-25; tools expose inputSchema +
   │  ── mock-serval (stdio) │   outputSchema, return structuredContent,
   │  ── real Serval (http)  │   readOnly/destructive annotations, isError results
   └────────────────────────┘
                │
   Cross-cutting: canUseTool HITL gate · OTel GenAI trace hook · memory file ·
   compaction · prompt caching · maxBudgetUsd + fallbackModel
```

### Units (each independently understandable & testable)

1. **`src/mock-serval/server.ts`** — standalone stdio MCP server
   (`@modelcontextprotocol/sdk` v1.x, spec `2025-11-25`) exposing Serval-faithful
   tools (input+output schemas, `structuredContent`, annotations, `isError`),
   backed by in-memory seed data.
2. **`src/agents/orchestrator.ts`** — the lean supervisor: builds the `query()`
   call, owns the orchestration system prompt (delegation contract, effort/budget
   heuristics, simplicity gate), wires permissions + tracing + memory.
3. **`src/agents/specialists.ts`** — the `AgentDefinition` map: three specialists,
   each with its own `description` (routing signal), `prompt`, scoped `tools`,
   `model`, `maxTurns`, and `outputFormat` schema.
4. **`src/config/connection.ts`** — the only place that decides mock vs live and
   produces the `mcpServers` config + `allowedTools`.
5. **`src/policy/access-policy.ts`** — deterministic access decision function
   (USER CONTRIBUTION). Pure TS, no LLM.
6. **`src/lib/permissions.ts`** — `canUseTool` human-in-the-loop gate.
7. **`src/lib/trace.ts`** — OpenTelemetry-GenAI-shaped structured trace emitter
   (one `trace_id` per run; `invoke_agent` / `execute_tool` / MCP spans). Also the
   event source for the web console.
8. **`src/lib/schemas.ts`** — Zod schemas (→ JSON Schema) for specialist
   structured findings and the access-decision shape.
9. **`src/index.ts`** — CLI entry (chat loop).
10. **`src/web/server.ts`** — `node:http` + SSE server that runs the orchestrator
    against the mock and streams the live trace to the browser.
11. **`src/web/public/index.html`** — single-page visual representation (the
    Conduit-style demo console + architecture page).

---

## 5. Agents, models & tool scoping (least privilege)

| Agent | Model (June 2026) | `effort` | Role | Allowed Serval tools |
|---|---|---|---|---|
| **Orchestrator** | `claude-opus-4-8` | `xhigh` + adaptive thinking | Route, delegate, synthesize; holds conversation | *(none direct — delegates only; has `Agent`)* |
| **Triage** | `claude-haiku-4-5` | n/a (Haiku has no adaptive thinking) | Classify/prioritize tickets, draft responses | `list_tickets`, `get_ticket`, `update_ticket`, `post_message` |
| **Access-Review** | `claude-sonnet-4-6` | `high` | Evaluate JIT access requests vs policy | `list_access_requests`, `get_access_request`, `get_user`, `review_access_request` |
| **Onboarding** | `claude-sonnet-4-6` | `high` | New-hire: tickets + access + workflow | `create_ticket`, `create_access_request`, `list_workflows`, `run_workflow`, `get_user` |

- Through the SDK, tools are referenced as `mcp__serval__<tool>`. The
  orchestrator's `allowedTools` includes `"Agent"` (required to enable delegation)
  but **no** `mcp__serval__*` — it acts only through specialists.
- **Tool search is disabled** (`ENABLE_TOOL_SEARCH: "false"`): our tool set is < 10
  (search hurts below ~10 tools) and Haiku 4.5 can't use it.
- **Resilience defaults:** `fallbackModel` set on the orchestrator; global
  `maxBudgetUsd` and per-agent `maxTurns` cap runaway cost/loops.

---

## 6. Orchestration flow (context-engineered)

1. User submits a request (CLI or web console).
2. The **orchestrator persists its plan to a memory file** before delegating (so it
   survives compaction/truncation).
3. **Simplicity gate:** trivial single-domain reads dispatch one specialist;
   compound requests fan out to multiple. The orchestrator **scales effort to
   complexity** (1 specialist for simple, 2–4 for compound) — encoded as a
   heuristic in its system prompt, not a rigid script ("right altitude").
4. For each specialist, the orchestrator issues a delegation carrying the **4-field
   contract**: objective, required output format, tool/source guidance, task
   boundaries. Critical instructions are placed at the **start and end** of the
   delegation prompt (lost-in-the-middle mitigation).
5. Each **specialist** runs its own isolated agent loop against the Serval MCP
   backend, then returns a **distilled, schema-validated finding** (SDK
   `outputFormat`) — a summary + any artifact references, **not** its transcript or
   raw payloads.
6. The **lean orchestrator** synthesizes specialist findings (which it holds as
   references/summaries, never raw tool output) into one answer; forwards
   specialist content **verbatim** where fidelity matters (avoid the "telephone
   game").
7. Any **write tool** (`create_*`, `update_ticket`, `run_workflow`,
   `review_access_request`) triggers the human-in-the-loop confirmation gate before
   executing. Write side-effects are **idempotent** (safe under retry).

### Worked example (the orchestration money-shot)

> "Onboard Jane Doe and review her pending access requests."

Orchestrator fans out to **Onboarding** (create onboarding ticket, request standard
access, kick off onboarding workflow) **and** **Access-Review** (evaluate Jane's
pending requests against policy), then merges both distilled findings into a clear,
attributed summary.

---

## 7. Mock backend & real-ready swap

- **Mock** (`SERVAL_MODE=mock`, default): `connection.ts` returns
  `mcpServers: { serval: { command: "node", args: ["src/mock-serval/server.ts"] } }`
  (Node runs the `.ts` directly — no build).
- **Live** (`SERVAL_MODE=live`): returns
  `mcpServers: { serval: { type: "http", url: SERVAL_MCP_URL, headers: { Authorization: "Bearer " + SERVAL_TOKEN } } }`.
- Both expose **identical tool names/shapes**, so agent prompts and `allowedTools`
  (`mcp__serval__*`) are unchanged across modes.

### Mock fidelity rules (MCP spec `2025-11-25`)

- Built with `@modelcontextprotocol/sdk` v1.x, `registerTool` taking Zod
  **`inputSchema` and `outputSchema`**; handlers return **both** a JSON text block
  (back-compat) and `structuredContent` (validated against `outputSchema`).
- Identical `snake_case` tool names and shapes to Serval's real API.
- **Tool annotations** on every tool: `readOnlyHint` for reads;
  `destructiveHint`/`idempotentHint` for writes.
- **Error semantics (SEP-1303):** business + input-validation errors returned as
  `{ isError: true }` results (not thrown), so the agent self-corrects. A
  deterministic trigger (sentinel ticket ID) forces an error path for testing.
- **Resource links** for any large payload (return a pointer, not the blob) to keep
  context lean.
- Logs go to **stderr only** (stdout is the JSON-RPC channel).
- Realistic seed data: tickets (varied priority/status incl. a sentinel error one),
  users (incl. one inactive), pending access requests (incl. one admin/prod-scoped),
  one onboarding workflow.

---

## 8. Best practices implemented (explicit, per user request)

Sourced from Anthropic *Building Effective Agents*, *How we built our multi-agent
research system*, *Effective context engineering for AI agents*, *Context
management* (memory tool + context editing), *Code execution with MCP*; the Claude
Agent SDK TS docs; MCP spec `2025-11-25`; OpenTelemetry GenAI conventions;
OpenAI/LangChain operational findings; and Node/TypeScript 2026 tooling docs.

### Orchestration & agents

| # | Best practice | Implementation |
|---|---|---|
| 1 | Orchestrator-workers (dynamic decomposition) | Main `query()` + `agents` map; delegate via `Agent` tool |
| 2 | 4-field delegation contract | Mandated in orchestrator system prompt |
| 3 | Start simple / gate multi-agent | Complexity heuristic; single specialist for simple reads |
| 4 | Effort scaling to complexity | Per-agent `maxTurns` + scaling rules in prompt |
| 5 | Least privilege per agent | Scoped `AgentDefinition.tools` (§5) |
| 6 | Mixed-tier models (strong lead, cheap leaves) | opus orchestrator; sonnet/haiku specialists |
| 7 | `effort` + adaptive thinking | `xhigh` orchestrator; `high` sonnet specialists |
| 8 | System prompt at the right "altitude" | Heuristics, not rigid scripts or vague platitudes |
| 9 | Verbatim forwarding (anti-telephone-game) | Orchestrator forwards specialist text where fidelity matters |

### Context engineering & reliability

| # | Best practice | Implementation |
|---|---|---|
| 10 | Lean supervisor (references not payloads) | Orchestrator holds plan + distilled findings only |
| 11 | Context isolation | Native subagent isolation; self-contained delegation prompt |
| 12 | Distilled returns | Specialists return summaries/pointers, never transcripts |
| 13 | Context-rot mitigation | Critical instructions at prompt edges; aggressive distractor filtering |
| 14 | Compaction for long runs | SDK automatic compaction enabled |
| 15 | External memory | Orchestrator persists plan to a memory file |
| 16 | Stopping conditions / resumability | Per-agent + global `maxTurns`, `maxBudgetUsd`; checkpoint plan |
| 17 | Idempotent side-effects | Write tools safe under retry |
| 18 | Surface tool failures to the agent | `isError` results fed back so the agent adapts |

### Tools / MCP

| # | Best practice | Implementation |
|---|---|---|
| 19 | Faithful mock | Identical names/shapes, seeds, simulated errors |
| 20 | Structured tool output | `outputSchema` + `structuredContent` (spec 2025-11-25) |
| 21 | Tool annotations | `readOnlyHint`/`destructiveHint`/`idempotentHint` on every tool |
| 22 | `isError`, don't throw (SEP-1303) | Mock handlers return error results |
| 23 | Resource links for big payloads | Pointers, not inlined blobs |
| 24 | Curated, non-overlapping tools | Minimal per-specialist tool surface |

### Safety / security

| # | Best practice | Implementation |
|---|---|---|
| 25 | Human-in-the-loop on writes | `canUseTool` gate in `lib/permissions.ts` |
| 26 | Never bypass-mode orchestrator | `permissionMode: "default"`; destructive patterns in `disallowedTools` |
| 27 | Two-layer output safety | Guardrail filter + typed (Zod) validation on every boundary |
| 28 | Deterministic safety in code | `policy/access-policy.ts` pure function (user contribution) |
| 29 | Tool-definition pinning | Hash mock tool defs on first load; warn on drift (rug-pull defense) |

### Structured output, observability, eval

| # | Best practice | Implementation |
|---|---|---|
| 30 | Native structured outputs | SDK `outputFormat` (Zod→JSON schema) + auto re-prompt |
| 31 | OTel GenAI observability | `lib/trace.ts`: one `trace_id`, `invoke_agent`/`execute_tool`/MCP spans, token/cost attrs |
| 32 | End-state eval (default) | `*.eval.ts` scenarios graded on final Serval state |
| 33 | Small eval set + LLM-judge (offline) | ~6–8 scenarios, single-call rubric judge, gated behind `RUN_EVALS` |
| 34 | Humans in the eval loop | Manual demo runs alongside automated evals |

### SDK / model controls

| # | Best practice | Implementation |
|---|---|---|
| 35 | Model fallback | `fallbackModel` on orchestrator |
| 36 | Cost cap | `maxBudgetUsd` on the query |
| 37 | Tool search off for small sets | `ENABLE_TOOL_SEARCH: "false"` |
| 38 | Prompt caching | Cache tool defs + stable system prompt (1h TTL) |
| 39 | Stream subagent activity | `forwardSubagentText` for the visual showcase |
| 40 | Real-ready backend swap | `config/connection.ts` env-driven switch |

### SDK correctness notes (must-follow)

- Package: **`@anthropic-ai/claude-agent-sdk`** (NOT the old `claude-code`).
- Include **`"Agent"` in `allowedTools`** or subagents never spawn.
- Subagents cannot nest (one level) — do not give specialists the `Agent` tool.
- The `Task` tool was renamed **`Agent`** (emitted as `"Agent"`, still `"Task"` in
  the init tools list + permission denials) — match both for compatibility.
- MCP tools referenced as `mcp__serval__<tool>`; pre-approve reads via wildcard.
- Custom SDK tools return `{ content: [...] }` and use `isError: true`, never throw.
- `ANTHROPIC_API_KEY` required.

---

## 9. Context engineering & reliability (detail)

- **Smallest high-signal token set:** the supervisor never ingests raw specialist
  output; specialists never dump transcripts. Pass references, pull on demand.
- **Just-in-time context:** agents load Serval data via tools at runtime (IDs/refs
  in context, payloads fetched only when needed) rather than pre-loading.
- **Context rot defenses:** keep each agent's window small; place critical
  instructions at the edges (lost-in-the-middle); filter distractors before they
  enter context.
- **Long-horizon:** automatic compaction (summarize/clear stale tool results first)
  + an external memory file for the orchestrator's plan.
- **Reliability spine:** checkpoint the plan; idempotent write side-effects;
  surface tool failures into context; wrap every output boundary in Zod
  validate-and-reask (the SDK's `outputFormat` provides the re-prompt loop);
  guardrail filter before parse.

---

## 10. Observability & evaluation

- **`lib/trace.ts`** emits a structured trace following **OpenTelemetry GenAI
  semantic conventions**: one `trace_id` per user request spanning
  `invoke_agent` (orchestrator) → `invoke_agent` (each specialist) →
  `execute_tool` (each MCP call), with `gen_ai.request.model`,
  `gen_ai.usage.input_tokens`/`output_tokens`, tool name/args/result, and
  `mcp.method.name`. Subagent attribution via `parent_tool_use_id`. This same
  stream feeds the web console.
- **Evaluation (`tests/eval/`)**: ~6–8 end-to-end scenarios graded by **end-state**
  (did Serval reach the correct state?) — not trajectory — with a **single-call
  LLM-as-judge** rubric (routing correctness, completeness, no unintended writes),
  run **offline** behind `RUN_EVALS=1` (not inline, due to latency/cost/flake).
  Assert on **thresholds**, never exact text. At least one multi-agent fan-out
  scenario. Humans review demo runs for edge cases evals miss.

---

## 11. Safety & security model

- **Reads** (`list_*`, `get_*`) auto-approved; **writes** require explicit CLI/web
  confirmation via `canUseTool`.
- Orchestrator runs in `permissionMode: "default"` (never bypass) so specialists
  cannot inherit an over-privileged mode. Destructive patterns also in
  `disallowedTools` (denied even under bypass).
- **Least privilege:** each specialist gets only its tool slice (§5).
- **Tool-definition pinning:** hash the mock's tool definitions on first load; warn
  on drift (defense against the MCP "rug pull" / tool-redefinition threat).
- **Untrusted annotations:** treat tool descriptions/annotations as untrusted input
  (don't let them drive privileged behavior).
- **Access-Review** must call the deterministic `policy/access-policy.ts` and
  respect its verdict; the LLM does not unilaterally approve access.

---

## 12. User contribution (learning mode)

`src/policy/access-policy.ts` exposes:

```ts
export type AccessDecision = "approve" | "deny" | "escalate";

export interface AccessRequestContext {
  resource: string;         // e.g. "github", "aws-prod", "salesforce"
  scope: string;            // e.g. "read", "admin", "write"
  requesterActive: boolean; // is the requesting user active?
  isProduction: boolean;    // does this touch a production system?
  isAdmin: boolean;         // is this an admin-level grant?
}

/**
 * Decide how to handle a just-in-time access request.
 * The user implements the ~8-line policy body.
 */
export function decideAccess(ctx: AccessRequestContext): {
  decision: AccessDecision;
  reason: string;
};
```

Note: `AccessDecision` is a **union type**, not a TS `enum` — enums are
non-erasable and would break native Node TS execution (§14). The scaffold provides
the file, types, signature, doc comment, and a TODO. The **user writes the ~8-line
decision body** (the genuine business logic: trade-offs between auto-approving
low-risk reads, escalating admin/prod grants, denying inactive requesters).
`tests/policy.test.ts` is pre-written so the user can verify immediately.

---

## 13. Visual representation (demo web console)

A single-page **visual representation of the solution**, styled after the "Conduit"
reference (`procore-salesforce-mcp.burademirung.workers.dev`): engineering-forward,
light-mode, flat/minimal, diagram-heavy.

### Principle

The web console is a **second consumer of the same orchestration core** as the CLI
— not a separate mock. A scenario button triggers a real orchestrator run against
the mock Serval backend; the live OTel-shaped trace (`lib/trace.ts`) streams to the
browser via **SSE** and renders as an animated agent/tool pipeline. One engine, two
surfaces.

### Page sections (mirroring the reference)

1. **Hero** — title + tagline + primary CTA ("Run a scenario").
2. **Live demo console** — scenario buttons (Triage tickets, Review access,
   Onboard employee, **Fan-out: onboard + review**). Clicking runs the orchestrator
   and streams steps `Orchestrator → Specialist → mcp__serval__* tool → result`
   with idle/running/complete badges and a log-style output pane.
3. **Architecture diagram** — monospace/ASCII supervisor→specialists→MCP (the §4
   diagram), labeled planes (Orchestration / Serval system of record).
4. **Agent registry table** — the §5 table (agent · model · effort · role · scoped
   tools) with read/write badges.
5. **Cutting-edge stack grid** — the §3 table rendered as cards.
6. **Best-practices grid** — the §8 matrix as cards (practice → implementation).
7. **Mock-vs-live topology** — the `connection.ts` swap (stdio mock ⇄ remote Serval
   MCP over HTTP+Bearer).
8. **Status/roadmap** — live (mock, orchestration, trace) vs. pending (verified
   live Serval connection; code-mode scaling path).
9. **Footer** — links to spec/plan docs and Serval references.

### Style & modern techniques

- Background white `#ffffff`; ink `#1a1a1a`; teal/cyan accent `#06b6d4`; status
  green `#10b981` / amber / red (reused for access verdicts: approve/escalate/deny).
- Fonts: display **Bricolage Grotesque**, body **Hanken Grotesk**, mono **IBM Plex
  Mono** (Google Fonts via `<link>`, `display=swap` + `preconnect`).
- Flat `1px solid #e5e7eb` boxes, no shadows, minimal radius; emoji inline icons.
- **Zero build step** — one static `index.html` (vanilla HTML/CSS/JS).
- Modern Baseline-2026 CSS: **`:has()`** for state-aware styling, **container
  queries** so the console embeds anywhere, **view transitions** for stage changes,
  native CSS nesting. All motion gated behind **`prefers-reduced-motion`**.
- Accessibility: streaming log is an `aria-live="polite"` `role="log"` region;
  semantic landmarks; visible focus; WCAG-AA contrast.

### Endpoints (`src/web/server.ts`, `node:http` + SSE)

- `GET /` → serves `index.html`.
- `GET /events?scenario=<id>` → SSE stream; runs the orchestrator for that scenario
  and emits trace events (`agent_start`, `delegate`, `tool_call`, `tool_result`,
  `synthesis`, `done`). SSE best practices: `Content-Type: text/event-stream`,
  `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, 25 s heartbeat,
  `id:`/`retry:`, and `req.on('close')` cleanup.
- Browser uses `EventSource` + `addEventListener` per event type.
- Demo uses the mock backend, so it runs with only `ANTHROPIC_API_KEY`.

---

## 14. Tech stack

- **Runtime:** Node **v25** (installed) — runs `.ts` directly via stable type
  stripping; **no build step, no `tsx`, no `dotenv`, no `nodemon`, no bundler**.
  Run/dev: `node --watch --env-file=.env src/index.ts`.
- **Language:** TypeScript 5.8+, **ESM** (`"type": "module"`), **erasable syntax
  only** (no enums/namespaces/param-properties; explicit `.ts` import extensions;
  `import type` for type-only imports).
- **`tsconfig.json`:** `module`/`moduleResolution: "nodenext"`, `noEmit: true`
  (tsc only type-checks), `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`,
  `rewriteRelativeImportExtensions: true`, `strict: true`,
  `noUncheckedIndexedAccess: true`.
- **Agent framework:** `@anthropic-ai/claude-agent-sdk`.
- **MCP server:** `@modelcontextprotocol/sdk` (pin **v1.x**; spec `2025-11-25`;
  `server/mcp.js` + `server/stdio.js`). (v2 is alpha — not for production.)
- **Validation:** `zod` (≥ 3.25 / v4) — `z.toJSONSchema()` for SDK `outputFormat`
  and MCP `outputSchema`.
- **Tests:** `vitest` v3 (`environment: 'node'`, v8 coverage); deterministic tests
  in `*.test.ts`, LLM-judge evals in `*.eval.ts` behind `RUN_EVALS`. Business logic
  is **DI-friendly** (model injected, not imported) for deterministic testing.
- **Web console:** built-in `node:http` + SSE; one static `index.html`.
- **Imports:** `node:`-prefixed built-ins; package.json **subpath imports**
  (`#…`) instead of tsconfig `paths` (the stripper rejects path aliases).
- **Auth:** `ANTHROPIC_API_KEY` (agent); `SERVAL_TOKEN` only for live mode.
- **Prod deps target:** essentially just the Agent SDK + MCP SDK + Zod (everything
  else is Node built-in or dev-only).

---

## 15. Project structure

```
serval-orchestrator/
├── src/
│   ├── mock-serval/server.ts      # stdio MCP server (2025-11-25): tools + seeds + schemas + annotations + isError
│   ├── agents/
│   │   ├── orchestrator.ts        # lean supervisor: contract, budgets, gate, opus/xhigh, memory, trace
│   │   └── specialists.ts         # AgentDefinition map: triage/access/onboarding, scoped tools, outputFormat
│   ├── config/connection.ts       # mock(stdio) ⇄ live(http+Bearer) swap via SERVAL_MODE
│   ├── policy/access-policy.ts     # ← USER contribution: deterministic approve/deny/escalate
│   ├── lib/
│   │   ├── permissions.ts          # canUseTool human-in-loop gate (reads free, writes confirm)
│   │   ├── trace.ts                # OTel-GenAI trace emitter + SSE event source
│   │   └── schemas.ts              # Zod schemas (→ JSON Schema) for findings + access decision
│   ├── web/
│   │   ├── server.ts               # node:http + SSE: runs orchestrator, streams trace
│   │   └── public/index.html       # visual representation (demo console + architecture)
│   └── index.ts                    # CLI entry (chat loop)
├── tests/
│   ├── mock.test.ts                # tool handlers: valid/invalid/error paths, structuredContent shape
│   ├── policy.test.ts              # pure unit tests for decideAccess (pre-written)
│   └── eval/scenarios.eval.ts      # ~6–8 end-state LLM-judge scenarios (gated by RUN_EVALS)
├── tsconfig.json                   # nodenext + verbatimModuleSyntax + erasableSyntaxOnly
├── package.json                    # ESM; scripts use node --watch --env-file
├── .env.example                    # ANTHROPIC_API_KEY, SERVAL_MODE, SERVAL_MCP_URL, SERVAL_TOKEN
└── README.md                       # run instructions, architecture, best-practices showcase
```

---

## 16. Testing & verification

- **`tests/mock.test.ts`** — unit-test mock tool handlers (pure functions): valid
  input, invalid input, simulated error path; assert `CallToolResult` shape,
  `structuredContent` conformance to `outputSchema`, and `isError`.
- **`tests/policy.test.ts`** — pure unit tests for `decideAccess` across the
  decision matrix (low-risk read → approve; admin/prod → escalate; inactive →
  deny). Pre-written so the user's implementation is verifiable immediately.
- **`tests/eval/scenarios.eval.ts`** — end-to-end scenarios (gated by `RUN_EVALS`)
  driving the orchestrator, graded by an end-state LLM-judge rubric. Includes a
  multi-agent fan-out scenario.
- **Type safety:** `npm run typecheck` (`tsc --noEmit`) — Node does no type
  checking, so this is the type gate.
- **Demo script** — a scripted multi-part request that visibly fans out and
  synthesizes, for live demonstration (CLI + web console).

A change is "done" only when: `npm run typecheck` is clean, `npm test` passes, the
policy tests pass with the user's implementation, and the fan-out demo runs
end-to-end against the mock producing a correct synthesized answer with a visible
trace.

---

## 17. Scope decisions & deferred frontier options

Documented deliberate choices (frontier-aware, not built):

- **Code execution with MCP ("code mode"):** the 98.7%-token-reduction pattern
  (present MCP tools as code APIs, agent writes code, sandbox executes). **Deferred**
  — it requires a secure, resource-limited sandbox to run model-written code, and
  our ~12-tool surface is exactly the "handful of tools → direct calls" case where
  the research recommends *against* it. Documented as the **scaling path** for when
  the tool surface grows to hundreds.
- **Agent teams** (lead supervising peer sessions) and the **Workflow tool**
  (script-based orchestration for dozens–hundreds of agents): noted as the next
  primitives if the supervisor needs more specialists than one conversation holds.
  The PoC uses plain subagents (right-sized for 3 specialists).
- **Managed Agents** (hosted REST runtime): the production target after a SDK
  prototype; out of scope for a local PoC.
- **MCP `2026-07-28` RC** (stateless core, MCP Apps in-chat UI, Tasks extension)
  and **MCP SDK v2** (package split, Standard Schema): pre-final/alpha in June 2026
  — tracked for migration, not adopted.
- **Elicitation / sampling** (MCP `2025-11-25`): not needed for the PoC flows.

---

## 18. Open risks / caveats

- **Token cost:** multi-agent runs use ~15× the tokens of a single chat; mitigated
  by mixed-tier models, effort/turn budgets, the simplicity gate, `maxBudgetUsd`,
  compaction, and tool-search-off. Live demos stay scenario-scoped.
- **Supervisor fidelity:** the supervisor can distort specialist output ("telephone
  game"); mitigated by verbatim forwarding where it matters.
- **SDK/spec churn:** the Agent SDK + MCP spec evolve quickly (recent `Task`→`Agent`
  rename, MCP `2025-11-25`, upcoming v2/RC); pin versions and follow §8 notes.
- **Native TS footguns:** non-erasable syntax (enums/param-properties/namespaces)
  crashes native Node run — `erasableSyntaxOnly` turns these into compile errors;
  `verbatimModuleSyntax` prevents silently dropped runtime imports.
- **Live mode unverified:** real Serval MCP connection cannot be tested without a
  workspace; the swap is built to spec but verified only against the mock.
- **LLM-judge bias:** position/length/surface-cue biases — mitigated by rubric
  scoring, randomized order, and threshold (not exact-match) assertions.
</content>
