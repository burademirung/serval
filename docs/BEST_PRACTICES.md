# Best Practices, Security & Verification

This document is the authoritative, evidence-based reference for **how this system applies AI-agent and orchestration best practices, and how we know it is secure and robust.** Every claim below is mapped to a specific mechanism in the code and to the verification that backs it. It was last reconciled against the implementation via two independent audits (a security/robustness audit and an agent/orchestration best-practice audit) and corrected so the documentation does not overstate the code.

- **Agent design best practices** → [Part 1](#part-1--ai-agent-design-best-practices)
- **Orchestration design best practices** → [Part 2](#part-2--orchestration-design-best-practices)
- **Security** → [Part 3](#part-3--security)
- **Robustness** → [Part 4](#part-4--robustness)
- **Verification & evidence** → [Part 5](#part-5--verification--evidence)
- **Honest limitations** → [Part 6](#part-6--honest-limitations-demo-vs-production)

---

## How to read this

Each practice is listed as **Practice → Implementation (`file`) → Verification**. Status is one of:
- **✅ Implemented** — present in code and verified.
- **⚙️ Optional/env-gated** — the mechanism exists but is off by default (documented as such).
- **📋 Deferred** — intentionally not built; documented with the reason and the upgrade path.

---

## Part 1 — AI agent design best practices

| # | Practice | Status | Implementation | Verification |
|---|---|---|---|---|
| 1 | **Clear tool design / agent-computer interface** — distinct, well-described tools | ✅ | `src/mcp/serval.ts` — 12 `snake_case` tools, each with a description, typed Zod `inputSchema`, and annotations | MCP Inspector lists all 12 with schemas; unit tests in `tests/mcp-tools.test.ts` |
| 2 | **Structured, validated output** — agents return typed objects, not prose | ✅ | Specialists return a `Finding` parsed by `FindingSchema.parse` (`src/lib/schemas.ts`, `src/agents/base-specialist.ts`) | Schema enforced at runtime; fallback path tested by construction |
| 3 | **Validate-and-reask on bad output** — one corrective retry before giving up | ✅ | `runSpecialist` → `extractFinding`; on failure, one re-ask, then a deterministic fallback (`src/agents/base-specialist.ts`) | Code path: parse → re-ask → fallback (3-stage) |
| 4 | **Stopping conditions** — bounded tool loops, no runaway | ✅ | `runToolLoop` caps at `maxSteps` (10 for specialists; default 8) and `maxTokens` (`src/lib/anthropic.ts`) | Loop exits with `"(stopped: max steps reached)"`; no recursion |
| 5 | **Surface tool errors to the agent** — let it adapt, don't crash | ✅ | Tool results carry `is_error`; `isError` from MCP is fed back into the loop (`src/lib/anthropic.ts`, `base-specialist.ts`) | Sentinel `TCK-ERROR` exercises the error path; `get_ticket{TCK-ERROR}` returns `isError:true` (verified live) |
| 6 | **Model tiering** — strong model where it matters, cheap on the leaves | ✅ | Supervisor `claude-opus-4-8`; Triage `claude-haiku-4-5`; Access-Review/Onboarding `claude-sonnet-4-6` — IDs in env vars | `wrangler deploy` shows the model vars; live runs use them |
| 7 | **Reasoning effort** — `effort` knob for harder reasoning | ⚙️ | `runToolLoop`, `synthesize`, and `route` accept `effort` and pass `output_config.effort` when `CLAUDE_EFFORT` is set (`src/lib/anthropic.ts`, `src/agents/supervisor.ts`) | Off by default (demo safety); set `CLAUDE_EFFORT=high` to enable |
| 8 | **System-prompt "altitude"** — heuristics, not rigid scripts | ✅ | Specialist + supervisor prompts give intent and rules ("classify and prioritize", "never invent ids — list/get first"), not step lists | Reviewed in `src/agents/*.ts` |
| 9 | **Least-privilege tool scoping** — an agent can't see tools it shouldn't use | ✅ | `toAnthropicTools(tools, cfg.allow)` filters to each specialist's allowlist *before* tools reach the model (`src/lib/mcp-tools.ts`, `base-specialist.ts`) | Security audit confirmed enforcement is pre-model; allowlists are non-overlapping and minimal |
| 10 | **Just-in-time context** — load data via tools, not pre-stuffed | ✅ | No ticket/user/access data is baked into any prompt; agents call tools to retrieve | Reviewed — prompts instruct "list/get first" |

---

## Part 2 — Orchestration design best practices

| # | Practice | Status | Implementation | Verification |
|---|---|---|---|---|
| 11 | **Orchestrator–workers pattern** — a supervisor decomposes and delegates | ✅ | `SupervisorAgent.stream` delegates to specialist DOs via `getAgentByName()` RPC (`src/agents/supervisor.ts`) | Live runs show delegate → specialist → result |
| 12 | **Dynamic routing / simplicity gate** — the supervisor decides *which* specialists are needed | ✅ | `route(env, prompt, fallback)` asks the supervisor model for the specialist set: one for single-domain, several only if it spans domains; falls back to the scenario set (`src/agents/supervisor.ts`) | **Verified live:** the triage prompt routes to `[triage]` only; the fan-out prompt routes to `[onboarding, access-review]` |
| 13 | **4-field delegation contract** — objective, output format, tools, boundaries | ✅ | The `taskSpec` string carries all four fields (`src/agents/supervisor.ts`) | Inspected in code |
| 14 | **Context isolation** — each agent gets a clean context window | ✅ | Each specialist is a separate Durable Object (fresh per-run instance id); the supervisor never receives transcripts, only `Finding` objects | Architecture-enforced (separate DOs); audit confirmed |
| 15 | **Distilled returns** — specialists return summaries + references, not payloads | ✅ | `Finding` = summary + actions + references; the prompt says "IDs in references, never raw payloads" (`src/lib/schemas.ts`, `base-specialist.ts`) | Schema + prompt both enforce it |
| 16 | **Parallel fan-out** — independent specialists run concurrently | ✅ | `Promise.all(specialists.map(...))` (`src/agents/supervisor.ts`) | Live fan-out shows both specialists active |
| 17 | **Synthesis as a real step** — a model call merges findings, with fallback | ✅ | `synthesize()` calls the supervisor model (opus); on any failure falls back to a deterministic merge (`src/agents/supervisor.ts`) | Live runs produce a synthesized answer; fallback covers the no-key path |
| 18 | **One-level delegation** — no runaway sub-spawning | ✅ | Specialists only call `runSpecialist`; none can spawn further agents | Structural — verified in `src/agents/*.ts` |
| 19 | **Verbatim fidelity where it matters** — raw findings preserved | ✅ | Per-specialist `summary` is forwarded verbatim into synthesis and included in `OrchestratorResult.findings` | Present in the `done` payload |
| 20 | **Per-run observability** — a single trace ties a run together | ✅ | `traceId` (a UUID) attached to every SSE event; events: `run_start`/`delegate`/`tool_call`/`tool_result`/`synthesis`/`done`/`error` (`src/lib/trace.ts`, `supervisor.ts`) | **Verified live:** every event carries a stable `traceId` |

> **Note on intra-specialist trace fidelity:** tool calls are surfaced *after* each specialist returns (reconstructed from `Finding.actions`), not streamed live mid-loop. A shared `TraceHub` Durable Object / WebSocket relay would stream them in real time — see [Part 6](#part-6--honest-limitations-demo-vs-production).

---

## Part 3 — Security

The system was audited adversarially. **No critical or high code vulnerability** (auth bypass, secret exfiltration, injection into a trusted sink) was found. The defenses below are real and verified.

### Enforced safety boundaries
- **Deterministic access policy, enforced in the tool** (`src/mcp/operations.ts` → `review_access_request`). The pure `decideAccess()` (`src/policy/access-policy.ts`) runs *inside* the tool; a permissiveness rank (`deny < escalate < approve`) guarantees the recorded decision can never exceed what policy allows. Even a jailbroken model cannot approve admin/production access. **Verified:** unit tests assert that an agent "approve" of write/admin/prod is downgraded to escalate (`tests/mcp-tools.test.ts`); the audit traced every case and confirmed no bypass via `create_access_request` (which only sets `status:"pending"`).
- **Least-privilege tool scoping** (Part 1 #9) — enforced before the model sees any tool.

### Secrets
- `ANTHROPIC_API_KEY` / `SERVAL_TOKEN` live in `.dev.vars` (gitignored, `chmod 600`) locally and **Wrangler secrets** in production. **Verified:** only `.dev.vars.example` (placeholders) is tracked; no `console.log` of secrets anywhere in `src/`; keys are read only into the Anthropic client and the MCP `Authorization` header, never echoed. SSE error events emit `error.message` only — no stack traces, no key material.

### Injection / XSS
- The console renders the live trace; **every dynamic SSE field is HTML-escaped** via `esc()` before any `innerHTML` write, and the synthesized answer uses `textContent` (`src/public/index.html`). This closed a DOM-XSS that an earlier revision introduced (LLM-influenced tool names could otherwise inject script). **Verified:** automated commit security review re-scanned and the audit confirmed every sink is escaped.

### MCP-specific hardening
- **Tool annotations treated as advisory** (`readOnlyHint` / `destructiveHint`), never used to grant privilege.
- **Errors as results** (`isError`) rather than thrown protocol errors, so a misbehaving tool can't crash the client.
- **Fail-safe live switch** — only an explicit `SERVAL_MODE=live` flips to the HTTP/Bearer path (`String(env.SERVAL_MODE) === "live"`); any other value (incl. a typo) stays on the mock and never sends the token off-box.

### Edge exposure controls (configurable)
- **Optional access gate** (`PUBLIC_ACCESS_TOKEN`): when set, `/mcp` (state-mutating) and `/api/run` (LLM-spending) require a bearer token / `?token=`. **Off by default** so the public demo stays open. **For a real org deployment, prefer Cloudflare Access + a Rate Limiting rule** in front of the Worker (see `docs/USAGE_AND_DEPLOYMENT.md`).
- **Bounded routes** — `/api/run` only accepts a scenario key from a fixed map (no arbitrary prompt/agent targeting); agent loops are bounded; delegation is one level.

---

## Part 4 — Robustness

- **Idempotent writes** — `create_ticket` / `create_access_request` honor an `idempotencyKey` so retries don't double-write (`src/mcp/operations.ts`). **Verified by unit test.**
- **Bounded everything** — tool loops (`maxSteps`), token budgets (`maxTokens`), one-level delegation, a fixed scenario→specialist fallback set. No unbounded recursion or fan-out.
- **Graceful degradation** — synthesis falls back to a deterministic merge on model failure; routing falls back to the scenario set; Finding parsing falls back after one re-ask. The SSE `start()` is wrapped in `try/catch/finally` that always closes the stream and emits a contained `error` event.
- **Input validation at every boundary** — Zod schemas on all MCP tool inputs; the untrusted LLM `Finding` JSON is validated with `FindingSchema.parse`.
- **Type safety** — the whole codebase passes `tsc --noEmit` (strict, `noUncheckedIndexedAccess`); SDK-shape risk is isolated to two files with explicit casts at the verified boundaries.

---

## Part 5 — Verification & evidence

How we *know* the above holds — not just assert it:

1. **Type checking** — `npm run typecheck` (`tsc --noEmit`, strict) passes clean.
2. **Unit tests** — `npm test`: 16 passing, 1 skipped (`@cloudflare/vitest-pool-workers`):
   - `tests/policy.test.ts` — the deterministic access policy (5 cases).
   - `tests/mcp-tools.test.ts` — pure tool operations incl. idempotency, the error sentinel, **and the policy-enforcement downgrade** (write/admin → escalate); plus MCP→Anthropic tool conversion.
   - `tests/eval/scenarios.test.ts` — scenario routing contract.
3. **Build validation** — `npx wrangler deploy --dry-run` bundles the Worker and recognizes all 5 Durable Object migrations.
4. **Runtime validation (`wrangler dev`)** — MCP Inspector lists 12 tools at `/mcp`; `list_tickets` ok; `get_ticket{TCK-ERROR}` returns `isError`.
5. **End-to-end live runs (deployed)** — the `triage` and `fanout` scenarios run real Claude orchestration in production; dynamic routing and per-run `traceId` verified on the wire.
6. **Independent audits** — a security/robustness audit (no critical/high code vulns; defenses confirmed) and an agent/orchestration best-practice audit (gaps identified and since fixed). This document reflects the corrected, reconciled state.
7. **Automated commit security review** — caught and we fixed a DOM-XSS before it shipped widely.

Reproduce locally:
```bash
npm run typecheck && npm test && npx wrangler deploy --dry-run
npm run dev        # then exercise /, /mcp (Inspector), /api/run?scenario=fanout
```

---

## Part 6 — Honest limitations (demo vs production)

Deliberate scope decisions — documented so the docs never overstate the build:

- **Reasoning `effort` / adaptive thinking** is wired but **off by default** (`CLAUDE_EFFORT`); enable per your model/cost trade-off.
- **Intra-specialist trace** is reconstructed post-return, not streamed live (a `TraceHub` DO would stream it).
- **Edge auth** is an optional token by default; production should use **Cloudflare Access + Rate Limiting** (the `/mcp` write surface and `/api/run` LLM cost are the exposure to gate).
- **Human-write-approval** (`REQUIRE_WRITE_APPROVAL` + `/api/approve`) is designed but the demo auto-approves writes; the deterministic access policy remains the real safety boundary regardless.
- **`outputSchema`** is not registered on MCP tools (we return `structuredContent` and validate client-side with Zod) — registering it is a straightforward enhancement.
- **Code execution with MCP**, **Cloudflare Workflows** durability, and **OAuth on the mock** are deferred with documented upgrade paths (see the design spec, §14).
- **Live Serval mode** is built to spec but verified only against the mock (no workspace credentials).

---

*See also: `README.md` (overview & quick start), `docs/USAGE_AND_DEPLOYMENT.md` (how to use, deploy, and adopt in an organization), and `docs/superpowers/` (design spec & implementation plan).*
