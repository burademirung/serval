# Serval Multi-Agent IT Orchestrator — Design Spec

**Date:** 2026-06-01
**Status:** Approved design, pre-implementation
**Author:** Brainstormed with user (vlad@degenito.ai)

---

## 1. Purpose & Goal

Build a **proof-of-concept multi-agent AI orchestrator** that operates against
[Serval](https://www.serval.com/)'s ITSM platform through its Model Context
Protocol (MCP) interface. The PoC showcases **supervisor + specialists
orchestration**: an Orchestrator agent routes each request to scoped specialist
agents (Triage, Access-Review, Onboarding), each of which acts on Serval's
system of record via MCP tools, then synthesizes a unified answer.

The PoC must:

- Demonstrate real multi-agent orchestration (fan-out + synthesis), not a single
  conversational agent.
- Run **immediately with no Serval account** via a faithful in-memory mock MCP
  backend, and flip to the **real Serval MCP server** with only an env/credential
  change ("mock now, real-ready").
- Embody current best practices for agent implementation and orchestration (see
  §7), since these were explicitly requested.

### Non-goals (YAGNI)

- No production deployment, auth server, or persistence layer beyond in-memory.
- No real Serval credentials required to run the demo.
- No UI beyond a terminal CLI chat.
- No attempt to replicate Serval's full API surface — only the tool slice the
  three specialists need.

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
  credentials (Client ID/Secret) come from the workspace admin dashboard. **No
  public sandbox exists** — hence the mock.
- MCP design: "every public API endpoint is automatically available as an MCP
  tool"; tools use `snake_case` (`list_tickets`, `create_ticket`, `get_user`,
  `list_workflows`, …); same permissions/rate-limits as REST.

The mock mirrors this tool surface so agents behave identically against mock or
real Serval.

---

## 3. Architecture

```
        ┌──────────────┐
        │ Orchestrator │  (main query(), model=opus, permissionMode=default)
        │  routes +    │  - gates multi-agent behind complexity check
        │  synthesizes │  - delegates via Agent tool with 4-field contract
        └──────┬───────┘
     ┌─────────┼──────────┐
     ▼         ▼          ▼
 ┌───────┐ ┌────────┐ ┌──────────┐
 │Triage │ │Access  │ │Onboarding│   (AgentDefinition specialists, scoped tools)
 │       │ │Review  │ │          │
 └───┬───┘ └───┬────┘ └────┬─────┘
     └─────────┼───────────┘
               ▼
   ┌────────────────────────┐   MCP (stdio mock now / HTTP+Bearer live later)
   │  Serval MCP backend     │
   │  ── mock-serval (stdio) │   tools: list_tickets, get_ticket, update_ticket,
   │  ── real Serval (http)  │          post_message, list_access_requests,
   └────────────────────────┘          get_access_request, review_access_request,
                                        create_ticket, create_access_request,
                                        list_workflows, run_workflow, get_user
```

### Units (each independently understandable & testable)

1. **`mock-serval/server.ts`** — standalone stdio MCP server (built on
   `@modelcontextprotocol/sdk`) exposing Serval-faithful tools backed by
   in-memory seed data. Single source of "Serval truth" for the demo.
2. **`agents/orchestrator.ts`** — the supervisor: builds the `query()` call,
   owns the orchestration system prompt (delegation contract, effort budgets,
   simplicity gate), wires permissions + tracing, runs the CLI loop turn.
3. **`agents/specialists.ts`** — the `AgentDefinition` map: three specialists,
   each with its own `description` (routing signal), `prompt`, scoped `tools`,
   `model`, and `maxTurns`.
4. **`config/connection.ts`** — the *only* place that decides mock vs live and
   produces the `mcpServers` config + `allowedTools` accordingly.
5. **`policy/access-policy.ts`** — deterministic access decision function (USER
   CONTRIBUTION). Pure TS, no LLM.
6. **`lib/permissions.ts`** — `canUseTool` human-in-the-loop gate.
7. **`lib/trace.ts`** — observability hook producing a structured decision/
   tool-call log.
8. **`lib/schemas.ts`** — Zod schemas validating specialist structured findings.
9. **`index.ts`** — CLI entry (chat loop).
10. **`web/server.ts`** — lightweight HTTP + SSE server that runs the
    orchestrator against the mock and streams the live trace to the browser.
11. **`web/public/index.html`** — single-page visual representation of the
    solution (the "Conduit"-style demo console + architecture page).

---

## 4. Agents & tool scoping (least privilege)

| Agent | Model | Role | Allowed Serval tools |
|---|---|---|---|
| **Orchestrator** | opus | Route, delegate, synthesize. Holds conversation. | *(none direct — delegates only; has `Agent`)* |
| **Triage** | haiku | Classify/prioritize tickets, draft responses | `list_tickets`, `get_ticket`, `update_ticket`, `post_message` |
| **Access-Review** | sonnet | Evaluate JIT access requests vs policy | `list_access_requests`, `get_access_request`, `get_user`, `review_access_request` |
| **Onboarding** | sonnet | New-hire: tickets + access + workflow | `create_ticket`, `create_access_request`, `list_workflows`, `run_workflow`, `get_user` |

Through the SDK these are referenced as `mcp__serval__<tool>`. The orchestrator's
`allowedTools` includes `"Agent"` (required to enable delegation) but **no**
`mcp__serval__*` — it must act only through specialists.

---

## 5. Orchestration flow

1. User submits a request to the CLI.
2. **Orchestrator** assesses complexity. Trivial single-domain reads may be
   handled by dispatching one specialist; compound requests fan out to multiple.
   (Simplicity gate: do not over-delegate.)
3. For each needed specialist, the orchestrator issues a delegation carrying the
   **4-field contract**: objective, required output format, tool/source guidance,
   task boundaries.
4. Each **specialist** runs its own isolated agent loop against the Serval MCP
   backend, then returns a **compressed, structured finding** (validated by a Zod
   schema) — not its transcript.
5. **Orchestrator** synthesizes specialist findings into one answer; forwards
   verbatim specialist content where fidelity matters (avoid the "telephone
   game").
6. Any **write tool** (`create_*`, `update_ticket`, `run_workflow`,
   `review_access_request`) triggers the human-in-the-loop confirmation gate
   before executing.

### Worked example (the orchestration money-shot)

> "Onboard Jane Doe and review her pending access requests."

Orchestrator fans out to **Onboarding** (create onboarding ticket, request
standard access, kick off onboarding workflow) **and** **Access-Review**
(evaluate Jane's pending requests against policy), then merges both results with
a clear, attributed summary.

---

## 6. Mock backend & real-ready swap

- **Mock** (`SERVAL_MODE=mock`, default): `config/connection.ts` returns
  `mcpServers: { serval: { command: "node", args: ["mock-serval/server.js"] } }`.
- **Live** (`SERVAL_MODE=live`): returns
  `mcpServers: { serval: { type: "http", url: SERVAL_MCP_URL, headers: { Authorization: "Bearer " + SERVAL_TOKEN } } }`.
- Both expose **identical tool names/shapes**, so agent prompts and `allowedTools`
  (`mcp__serval__*`) are unchanged across modes. Swapping backends is purely a
  config/credential change — no agent code edits.

### Mock fidelity rules

- Identical `snake_case` tool names and input/output shapes to Serval's real API.
- Realistic seed data: a handful of tickets (varied priority/status), users
  (incl. one inactive), pending access requests (incl. one admin/prod-scoped),
  and one onboarding workflow.
- Tool annotations on every tool (`readOnlyHint` for reads; `destructiveHint`
  for writes).
- Business errors returned as `{ isError: true }` results (not thrown), so the
  agent can self-correct. A deterministic trigger (e.g. a sentinel ticket ID)
  forces an error path for testing.

---

## 7. Best practices implemented (explicit, per user request)

Sourced from Anthropic *Building Effective Agents* / *How we built our
multi-agent research system*, the Claude Agent SDK TS docs, MCP spec/SDK
guidance, and OpenAI/LangChain operational findings.

| # | Best practice | Implementation |
|---|---|---|
| 1 | Orchestrator-workers pattern | Main `query()` + `agents` map; delegate via `Agent` tool |
| 2 | 4-field delegation contract | Mandated in orchestrator system prompt |
| 3 | Start simple / gate multi-agent | Complexity gate in orchestrator prompt |
| 4 | Effort budgets | Per-agent `maxTurns`; scaling rules in prompt |
| 5 | Context isolation | Native subagent isolation; specialists return compressed findings |
| 6 | Least privilege per agent | Scoped `AgentDefinition.tools` (§4) |
| 7 | Strong orchestrator, cheap specialists | opus orchestrator; sonnet/haiku specialists |
| 8 | Human-in-the-loop on writes | `canUseTool` gate in `lib/permissions.ts` |
| 9 | Never bypass-mode orchestrator | `permissionMode: "default"`; destructive patterns in `disallowedTools` |
| 10 | Tool annotations | `readOnlyHint`/`destructiveHint` on every mock tool |
| 11 | Return `isError`, don't throw | Mock handlers return error results |
| 12 | Faithful mock | Identical names/shapes, realistic seeds, simulated errors |
| 13 | Stopping conditions | Per-agent + global `maxTurns` / `maxBudgetUsd` |
| 14 | Observability/tracing | `lib/trace.ts` hook logs every agent decision + tool call |
| 15 | Structured output validation | Zod schemas in `lib/schemas.ts` |
| 16 | Small eval set + LLM-as-judge | `tests/eval/scenarios.ts`, rubric on trajectory + end-state |
| 17 | Deterministic safety in code | `policy/access-policy.ts` pure function (user contribution) |
| 18 | Real-ready swap | `config/connection.ts` env-driven backend switch |

### SDK correctness notes (must-follow)

- Package: **`@anthropic-ai/claude-agent-sdk`** (NOT the old `claude-code`).
- Node >= 18, ESM (`"type": "module"`).
- Include **`"Agent"` in `allowedTools`** or subagents never spawn.
- Subagents cannot nest (one level only) — do not give specialists the `Agent`
  tool.
- MCP tools are referenced as `mcp__serval__<tool>`; pre-approve with
  `mcp__serval__*` wildcard where appropriate.
- Custom SDK tools must return `{ content: [...] }` and use `isError: true` for
  failures rather than throwing.
- `ANTHROPIC_API_KEY` required in env.

---

## 8. Safety model

- **Reads** (`list_*`, `get_*`) auto-approved.
- **Writes** (`create_*`, `update_ticket`, `run_workflow`,
  `review_access_request`) require explicit CLI confirmation via `canUseTool`.
- Orchestrator runs in `permissionMode: "default"` (never bypass), so specialists
  cannot inherit an over-privileged mode.
- The Access-Review specialist must call the deterministic
  `policy/access-policy.ts` function and respect its verdict; the LLM does not
  unilaterally approve access.

---

## 9. User contribution (learning mode)

`policy/access-policy.ts` exposes:

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

The scaffold provides the file, types, signature, doc comment, and a TODO. The
**user writes the ~8-line decision body** (the genuine business logic: trade-offs
between auto-approving low-risk reads, escalating admin/prod grants, denying
inactive requesters). `tests/policy.test.ts` is pre-written so the user can
verify their implementation immediately.

---

## 10. Testing & verification

- **`tests/mock.test.ts`** — unit-test mock tool handlers: valid input, invalid
  input, and the simulated error path; assert `CallToolResult` shape + `isError`.
- **`tests/policy.test.ts`** — pure unit tests for `decideAccess` across the
  decision matrix (low-risk read → approve; admin/prod → escalate; inactive →
  deny).
- **`tests/eval/scenarios.ts`** — ~6–8 end-to-end scenarios driving the
  orchestrator, scored by an LLM-as-judge rubric on **trajectory** (did it route
  to the right specialist(s)?) and **end-state** (did Serval reach the correct
  state?). Includes at least one multi-agent fan-out scenario.
- **Demo script** — a scripted multi-part request that visibly fans out to
  multiple specialists and synthesizes, for live demonstration.

A change is "done" only when: `npm test` passes, the policy tests pass with the
user's implementation, and the demo scenario runs end-to-end against the mock
producing a correct synthesized answer with a visible trace.

---

## 11. Tech stack

- **Language/runtime:** TypeScript on Node v25 (installed), ESM.
- **Agent framework:** `@anthropic-ai/claude-agent-sdk`.
- **MCP server:** `@modelcontextprotocol/sdk` (stable v1.x;
  `server/mcp.js` + `server/stdio.js`).
- **Validation:** `zod`.
- **Test runner:** `vitest` (fast, ESM-native, TS-friendly).
- **Web console:** Node's built-in `http` + Server-Sent Events (no framework);
  single static `index.html` (vanilla HTML/CSS/JS, no build step).
- **Auth:** `ANTHROPIC_API_KEY` (agent); `SERVAL_TOKEN` only needed for live mode.
```

---

## 12. Visual representation (demo web console)

A single-page **visual representation of the solution**, styled after the
"Conduit" reference (`procore-salesforce-mcp.burademirung.workers.dev`):
engineering-forward, light-mode, flat/minimal, diagram-heavy.

### Principle

The web console is a **second consumer of the same orchestration core** as the
CLI — not a separate mock. A scenario button triggers a real orchestrator run
against the mock Serval backend; the live trace (`lib/trace.ts`) is streamed to
the browser and rendered as an animated agent/tool pipeline. One engine, two
surfaces.

### Page sections (mirroring the reference)

1. **Hero** — "Serval Multi-Agent IT Orchestrator", one-line tagline, primary CTA
   ("Run a scenario").
2. **Live demo console** — centered widget with scenario buttons (Triage tickets,
   Review access, Onboard employee, **Fan-out: onboard + review**). Clicking runs
   the orchestrator and streams steps: `Orchestrator → Specialist → mcp__serval__*
   tool → result`, with idle/running/complete status badges and a log-style output
   pane.
3. **Architecture diagram** — monospace/ASCII-style supervisor→specialists→MCP
   visualization (the §3 diagram), labeled planes (Orchestration / Serval system
   of record).
4. **Agent registry table** — the §4 table (agent · model · role · scoped tools),
   with read/write tool badges.
5. **Best-practices grid** — the §7 matrix rendered as cards (practice →
   implementation), conveying rigor like the reference's status section.
6. **Mock-vs-live topology** — shows the `config/connection.ts` swap (stdio mock
   ⇄ remote Serval MCP over HTTP+Bearer).
7. **Status/roadmap** — what's live (mock, orchestration, trace) vs. pending
   (verified live Serval connection).
8. **Footer** — links to the spec/plan docs and Serval references.

### Style tokens

- Background white `#ffffff`; text charcoal `#1a1a1a`; secondary grays.
- Accent teal/cyan `#06b6d4`; status green `#10b981` / amber / red (reused for the
  access-policy verdicts: approve=green, escalate=amber, deny=red).
- Fonts: display **Bricolage Grotesque**, body **Hanken Grotesk**, mono **IBM Plex
  Mono** (loaded via CDN/Google Fonts).
- Flat, `1px solid #e5e7eb` bordered boxes, no shadows, minimal radius; emoji
  inline icons.

### Endpoints (`web/server.ts`)

- `GET /` → serves `web/public/index.html`.
- `GET /run?scenario=<id>` → SSE stream; runs the orchestrator for that scenario
  and emits trace events (`agent_start`, `delegate`, `tool_call`, `tool_result`,
  `synthesis`, `done`).
- Reads use the mock backend so the page runs with only `ANTHROPIC_API_KEY`.

### Out of scope (YAGNI)

- Not deployed to Cloudflare Workers (the reference is; ours runs locally). The
  design keeps the page a static file + minimal server so a future Workers
  deployment is possible but is not built now.
- No live Serval calls from the browser demo (mock only), to keep it runnable.

---

## 13. Open risks / caveats

- **Token cost:** multi-agent runs use ~15× the tokens of a single chat; the PoC
  mitigates with cheap specialist models, effort budgets, and the simplicity
  gate, but live demos should stay scenario-scoped.
- **Supervisor fidelity:** the supervisor can distort specialist output
  ("telephone game"); mitigated by verbatim forwarding where it matters.
- **SDK churn:** the Agent SDK is evolving (recent `Task`→`Agent` rename, package
  rename); pin versions and follow the §7 SDK notes.
- **Live mode unverified:** real Serval MCP connection cannot be tested without a
  workspace; the swap is built to spec but verified only against the mock.
