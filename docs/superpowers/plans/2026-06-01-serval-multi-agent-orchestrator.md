# Serval Multi-Agent IT Orchestrator — Implementation Plan (Cloudflare)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build and deploy on Cloudflare a multi-agent IT orchestrator: a Supervisor Durable Object delegates (RPC, parallel) to Triage / Access-Review / Onboarding specialist Durable Objects, each running an Anthropic tool-loop (via AI Gateway) against a co-located mock Serval MCP server (`McpAgent`), with an SSE-streamed visual console.

**Architecture:** Cloudflare Workers + Durable Objects (Agents SDK). `SupervisorAgent` → specialist Agents via `getAgentByName()` RPC + `Promise.all`. Specialists call Claude with `@anthropic-ai/sdk` routed through AI Gateway, scoped to a slice of `ServalMCP` tools reached over the v0.6.0 RPC transport. UI = Workers Static Assets + SSE. Real-ready: flip `SERVAL_MODE=live` to target real Serval.

**Tech Stack:** TypeScript/ESM (wrangler-bundled), `agents` (Cloudflare Agents SDK), `@modelcontextprotocol/sdk` v1.x (MCP 2025-11-25), `@anthropic-ai/sdk`, `zod`, `@cloudflare/vitest-pool-workers`, `wrangler`.

**Reference spec:** `docs/superpowers/specs/2026-06-01-serval-multi-agent-orchestrator-design.md` (v3).

---

## Conventions

- Run from project root `/Users/vladimirkamenev/Documents/projects/serval`. Git repo + `.gitignore` exist; add `.dev.vars`, `.wrangler/`, `worker-configuration.d.ts` to `.gitignore` in Task 0.
- **Cloudflare rules:** `compatibility_flags: ["nodejs_compat"]`; all DO classes in `new_sqlite_classes` (new migration tag for new classes; never edit a tag); **do NOT enable `experimentalDecorators`**; secrets via `this.env`, never `process.env`; run `wrangler types` after editing `wrangler.jsonc`.
- **SDK-shape risk is isolated** to `src/lib/anthropic.ts`, `src/lib/mcp-tools.ts`, and the `this.mcp` client calls. If the installed `agents` / `@anthropic-ai/sdk` differ from the snippets, fix there only and re-run `wrangler dev` + MCP Inspector.
- Commit after each task with the shown message.

---

## File Structure (lock-in)

| File | Responsibility |
|---|---|
| `wrangler.jsonc` | 5 DO bindings, migration, assets, vars |
| `package.json` / `tsconfig.json` / `vitest.config.ts` / `.dev.vars.example` | toolchain |
| `src/lib/schemas.ts` | Finding / OrchestratorResult / AccessDecision (zod) |
| `src/policy/access-policy.ts` | deterministic `decideAccess()` (USER) |
| `src/mcp/seeds.ts` | seed store types + factory |
| `src/mcp/operations.ts` | 12 pure tool operations on a Store |
| `src/mcp/serval.ts` | `ServalMCP` McpAgent (registers tools, holds state) |
| `src/lib/mcp-tools.ts` | MCP tool list → Anthropic tools; callTool wrapper |
| `src/lib/anthropic.ts` | AI-Gateway Anthropic client + tool-loop runner |
| `src/lib/trace.ts` | trace event types + SSE encoder |
| `src/lib/scenarios.ts` | named demo scenarios |
| `src/agents/base-specialist.ts` | shared specialist tool-loop → Finding |
| `src/agents/triage.ts` / `access-review.ts` / `onboarding.ts` | the 3 specialists |
| `src/agents/supervisor.ts` | plan, fan-out RPC, SSE, synthesize |
| `src/index.ts` | Worker entry + routing |
| `src/public/index.html` | Conduit-style SSE console |
| `tests/*` | policy, operations, mcp-tools, eval |

---

## Task 0: Scaffold the Cloudflare project

**Files:** `package.json`, `wrangler.jsonc`, `tsconfig.json`, `vitest.config.ts`, `.dev.vars.example`, `.gitignore` (append)

- [ ] **Step 1: Make directories**

```bash
mkdir -p src/lib src/policy src/mcp src/agents src/public tests/eval
```

- [ ] **Step 2: `package.json`**

```json
{
  "name": "serval-orchestrator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "cf-typegen": "wrangler types",
    "test": "vitest run",
    "eval": "RUN_EVALS=1 vitest run tests/eval"
  },
  "dependencies": {
    "agents": "^0.6.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@anthropic-ai/sdk": "^0.40.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "wrangler": "^4",
    "@cloudflare/vitest-pool-workers": "^0.8",
    "typescript": "^5.8.0",
    "vitest": "^3"
  }
}
```

- [ ] **Step 3: `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "serval-orchestrator",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "src/public",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application"
  },
  "durable_objects": {
    "bindings": [
      { "name": "Supervisor", "class_name": "SupervisorAgent" },
      { "name": "Triage", "class_name": "TriageAgent" },
      { "name": "AccessReview", "class_name": "AccessReviewAgent" },
      { "name": "Onboarding", "class_name": "OnboardingAgent" },
      { "name": "ServalMCP", "class_name": "ServalMCP" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SupervisorAgent", "TriageAgent", "AccessReviewAgent", "OnboardingAgent", "ServalMCP"] }
  ],
  "vars": {
    "SERVAL_MODE": "mock",
    "MODEL_SUPERVISOR": "claude-opus-4-8",
    "MODEL_SONNET": "claude-sonnet-4-6",
    "MODEL_HAIKU": "claude-haiku-4-5"
  },
  "observability": { "enabled": true }
}
```

- [ ] **Step 4: `tsconfig.json`** (no `experimentalDecorators`)

```jsonc
{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["esnext"],
    "types": ["./worker-configuration.d.ts"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 5: `vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    poolOptions: {
      workers: { wrangler: { configPath: "./wrangler.jsonc" } },
    },
  },
});
```

> Pure-logic tests (policy, operations, mcp-tools) run fine in the Workers pool. If a test needs no Worker context it still runs; DO-backed tests use the pool's `env`.

- [ ] **Step 6: `.dev.vars.example`**

```bash
# Anthropic (required)
ANTHROPIC_API_KEY=sk-ant-...

# Cloudflare AI Gateway (route Anthropic through it)
CF_ACCOUNT_ID=your_account_id
GATEWAY_ID=serval-orchestrator

# Live Serval (only when SERVAL_MODE=live; set via wrangler secret in prod)
SERVAL_MCP_URL=https://public.api.serval.com/mcp/
SERVAL_TOKEN=
```

- [ ] **Step 7: Append to `.gitignore`**

```bash
printf '\n.dev.vars\n.wrangler/\nworker-configuration.d.ts\n' >> .gitignore
```

- [ ] **Step 8: Install + generate types**

Run: `npm install && npx wrangler types`
Expected: deps install; `worker-configuration.d.ts` generated with `Env` (DO namespaces + vars). (`wrangler types` may warn that `main` has no valid export yet — fine until Task 5.)

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore: scaffold Cloudflare Workers + Agents SDK project"
```

---

## Task 1: Schemas (`src/lib/schemas.ts`)

**Files:** Create `src/lib/schemas.ts`

- [ ] **Step 1: Write schemas**

```ts
import { z } from "zod";

export const FindingSchema = z.object({
  agent: z.enum(["triage", "access-review", "onboarding"]),
  summary: z.string(),
  actions: z.array(z.object({ tool: z.string(), target: z.string(), result: z.string() })).default([]),
  references: z.array(z.string()).default([]),
});
export type Finding = z.infer<typeof FindingSchema>;

export const OrchestratorResultSchema = z.object({
  answer: z.string(),
  specialistsUsed: z.array(z.enum(["triage", "access-review", "onboarding"])),
  findings: z.array(FindingSchema).default([]),
});
export type OrchestratorResult = z.infer<typeof OrchestratorResultSchema>;

export const AccessDecisionSchema = z.object({
  decision: z.enum(["approve", "deny", "escalate"]),
  reason: z.string(),
});
export type AccessDecisionResult = z.infer<typeof AccessDecisionSchema>;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/schemas.ts && git commit -m "feat: add zod schemas"
```

---

## Task 2: Access policy + tests (USER CONTRIBUTION)

**Files:** Create `src/policy/access-policy.ts`, `tests/policy.test.ts`

- [ ] **Step 1: Pre-write the tests**

`tests/policy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { decideAccess } from "../src/policy/access-policy";
import type { AccessRequestContext } from "../src/policy/access-policy";

const base: AccessRequestContext = {
  resource: "github", scope: "read",
  requesterActive: true, isProduction: false, isAdmin: false,
};

describe("decideAccess", () => {
  it("denies inactive requesters", () => {
    expect(decideAccess({ ...base, requesterActive: false }).decision).toBe("deny");
  });
  it("escalates admin grants", () => {
    expect(decideAccess({ ...base, isAdmin: true }).decision).toBe("escalate");
  });
  it("escalates production access", () => {
    expect(decideAccess({ ...base, isProduction: true, scope: "write" }).decision).toBe("escalate");
  });
  it("approves low-risk reads for active users", () => {
    expect(decideAccess(base).decision).toBe("approve");
  });
  it("always returns a non-empty reason", () => {
    for (const ctx of [base, { ...base, isAdmin: true }, { ...base, requesterActive: false }]) {
      expect(decideAccess(ctx).reason.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Create the policy file (signature + TODO)**

`src/policy/access-policy.ts`:
```ts
export type AccessDecision = "approve" | "deny" | "escalate";

export interface AccessRequestContext {
  resource: string;
  scope: string;
  requesterActive: boolean;
  isProduction: boolean;
  isAdmin: boolean;
}

/**
 * Deterministic safety boundary for just-in-time access requests.
 * The Access-Review agent MUST defer to this; the LLM does not self-approve.
 *
 * Implement the ~8-line body. Consider: inactive requesters never get access;
 * admin or production grants are high-stakes (escalate to a human); low-risk reads
 * for active users can auto-approve. Order checks so the most restrictive wins.
 */
export function decideAccess(ctx: AccessRequestContext): { decision: AccessDecision; reason: string } {
  // TODO(user): implement. Must satisfy tests/policy.test.ts.
  throw new Error("decideAccess not implemented");
}
```

- [ ] **Step 3: Run tests — expect FAIL**

Run: `npx vitest run tests/policy.test.ts`
Expected: FAIL ("decideAccess not implemented").

- [ ] **Step 4: USER implements the body**

> **HANDOFF TO USER:** Replace the TODO. Reference implementation that passes:
> ```ts
> if (!ctx.requesterActive) return { decision: "deny", reason: "Requester is inactive" };
> if (ctx.isAdmin) return { decision: "escalate", reason: "Admin grant needs human approval" };
> if (ctx.isProduction) return { decision: "escalate", reason: "Production access needs human approval" };
> if (ctx.scope === "read") return { decision: "approve", reason: "Low-risk read for active user" };
> return { decision: "escalate", reason: "Non-read access requires review" };
> ```

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx vitest run tests/policy.test.ts`
Expected: PASS (5).

- [ ] **Step 6: Commit**

```bash
git add src/policy/access-policy.ts tests/policy.test.ts && git commit -m "feat: add deterministic access policy + tests"
```

---

## Task 3: Mock seeds + pure operations + tests

**Files:** Create `src/mcp/seeds.ts`, `src/mcp/operations.ts`, `tests/mcp-tools.test.ts`

- [ ] **Step 1: `src/mcp/seeds.ts`**

```ts
export interface Ticket { id: string; subject: string; status: "open" | "pending" | "resolved"; priority: "low" | "medium" | "high" | "urgent"; requester: string; messages: { author: string; body: string }[]; }
export interface User { id: string; name: string; email: string; active: boolean; department: string; }
export interface AccessRequest { id: string; userId: string; resource: string; scope: "read" | "write" | "admin"; isProduction: boolean; status: "pending" | "approved" | "denied" | "escalated"; }
export interface Workflow { id: string; name: string; description: string; }
export interface Store { tickets: Ticket[]; users: User[]; accessRequests: AccessRequest[]; workflows: Workflow[]; idempo: Record<string, string>; seq: number; }

export const ERROR_TICKET_ID = "TCK-ERROR";

export function createStore(): Store {
  return {
    seq: 2000,
    idempo: {},
    tickets: [
      { id: "TCK-1001", subject: "VPN won't connect", status: "open", priority: "high", requester: "USR-2", messages: [] },
      { id: "TCK-1002", subject: "Request Figma license", status: "open", priority: "low", requester: "USR-3", messages: [] },
      { id: "TCK-1003", subject: "Laptop running slow", status: "pending", priority: "medium", requester: "USR-2", messages: [] },
    ],
    users: [
      { id: "USR-1", name: "Jane Doe", email: "jane@acme.com", active: true, department: "Engineering" },
      { id: "USR-2", name: "Bob Smith", email: "bob@acme.com", active: true, department: "Sales" },
      { id: "USR-3", name: "Carol Lee", email: "carol@acme.com", active: false, department: "Design" },
    ],
    accessRequests: [
      { id: "ACC-1", userId: "USR-1", resource: "github", scope: "write", isProduction: false, status: "pending" },
      { id: "ACC-2", userId: "USR-1", resource: "aws-prod", scope: "admin", isProduction: true, status: "pending" },
      { id: "ACC-3", userId: "USR-3", resource: "salesforce", scope: "read", isProduction: false, status: "pending" },
    ],
    workflows: [{ id: "WF-onboard", name: "Standard Onboarding", description: "Accounts, baseline access, laptop" }],
  };
}
```

- [ ] **Step 2: `src/mcp/operations.ts`** (pure: `(store, args) => { data } | { error }`)

```ts
import type { Store, Ticket, AccessRequest } from "./seeds";
import { ERROR_TICKET_ID } from "./seeds";

export type OpResult = { data: unknown } | { error: string };
const ok = (data: unknown): OpResult => ({ data });
const no = (error: string): OpResult => ({ error });

export const operations = {
  list_tickets: (s: Store): OpResult => ok({ tickets: s.tickets.map(({ messages, ...t }) => t) }),
  get_ticket: (s: Store, a: { id: string }): OpResult => {
    if (a.id === ERROR_TICKET_ID) return no("Simulated upstream error");
    const t = s.tickets.find((x) => x.id === a.id);
    return t ? ok(t) : no(`Ticket ${a.id} not found`);
  },
  update_ticket: (s: Store, a: { id: string; status?: Ticket["status"]; priority?: Ticket["priority"] }): OpResult => {
    const t = s.tickets.find((x) => x.id === a.id);
    if (!t) return no(`Ticket ${a.id} not found`);
    if (a.status) t.status = a.status;
    if (a.priority) t.priority = a.priority;
    return ok(t);
  },
  post_message: (s: Store, a: { id: string; body: string }): OpResult => {
    const t = s.tickets.find((x) => x.id === a.id);
    if (!t) return no(`Ticket ${a.id} not found`);
    t.messages.push({ author: "agent", body: a.body });
    return ok({ id: t.id, messageCount: t.messages.length });
  },
  list_access_requests: (s: Store): OpResult => ok({ accessRequests: s.accessRequests }),
  get_access_request: (s: Store, a: { id: string }): OpResult => {
    const r = s.accessRequests.find((x) => x.id === a.id);
    return r ? ok(r) : no(`Access request ${a.id} not found`);
  },
  review_access_request: (s: Store, a: { id: string; decision: "approve" | "deny" | "escalate" }): OpResult => {
    const r = s.accessRequests.find((x) => x.id === a.id);
    if (!r) return no(`Access request ${a.id} not found`);
    r.status = ({ approve: "approved", deny: "denied", escalate: "escalated" } as const)[a.decision] as AccessRequest["status"];
    return ok(r);
  },
  create_access_request: (s: Store, a: { userId: string; resource: string; scope: "read" | "write" | "admin"; isProduction?: boolean; idempotencyKey?: string }): OpResult => {
    const k = a.idempotencyKey && "acc:" + a.idempotencyKey;
    if (k && s.idempo[k]) return ok(s.accessRequests.find((x) => x.id === s.idempo[k]));
    const id = `ACC-${s.accessRequests.length + 100}`;
    const rec: AccessRequest = { id, userId: a.userId, resource: a.resource, scope: a.scope, isProduction: a.isProduction ?? false, status: "pending" };
    s.accessRequests.push(rec);
    if (k) s.idempo[k] = id;
    return ok(rec);
  },
  create_ticket: (s: Store, a: { subject: string; requester: string; priority?: Ticket["priority"]; idempotencyKey?: string }): OpResult => {
    const k = a.idempotencyKey && "tck:" + a.idempotencyKey;
    if (k && s.idempo[k]) return ok(s.tickets.find((x) => x.id === s.idempo[k]));
    const id = `TCK-${++s.seq}`;
    const rec: Ticket = { id, subject: a.subject, status: "open", priority: a.priority ?? "medium", requester: a.requester, messages: [] };
    s.tickets.push(rec);
    if (k) s.idempo[k] = id;
    return ok({ id: rec.id, subject: rec.subject, status: rec.status, priority: rec.priority });
  },
  get_user: (s: Store, a: { id: string }): OpResult => {
    const u = s.users.find((x) => x.id === a.id || x.email === a.id || x.name.toLowerCase() === String(a.id).toLowerCase());
    return u ? ok(u) : no(`User ${a.id} not found`);
  },
  list_workflows: (s: Store): OpResult => ok({ workflows: s.workflows }),
  run_workflow: (s: Store, a: { id: string; subjectUserId: string }): OpResult => {
    const wf = s.workflows.find((x) => x.id === a.id);
    if (!wf) return no(`Workflow ${a.id} not found`);
    return ok({ workflow: wf.id, subject: a.subjectUserId, status: "completed", steps: ["accounts", "baseline-access", "laptop"] });
  },
} as const;
```

- [ ] **Step 3: `tests/mcp-tools.test.ts`** (operations portion)

```ts
import { describe, it, expect } from "vitest";
import { createStore, ERROR_TICKET_ID } from "../src/mcp/seeds";
import { operations } from "../src/mcp/operations";

describe("mock serval operations", () => {
  it("lists seeded tickets", () => {
    const r = operations.list_tickets(createStore()) as { data: any };
    expect(r.data.tickets.length).toBe(3);
  });
  it("errors on unknown ticket", () => {
    expect(operations.get_ticket(createStore(), { id: "TCK-9" })).toHaveProperty("error");
  });
  it("errors on sentinel ticket", () => {
    expect(operations.get_ticket(createStore(), { id: ERROR_TICKET_ID })).toHaveProperty("error");
  });
  it("create_ticket is idempotent by key", () => {
    const s = createStore();
    const a = operations.create_ticket(s, { subject: "x", requester: "USR-1", idempotencyKey: "k" }) as { data: any };
    const b = operations.create_ticket(s, { subject: "x", requester: "USR-1", idempotencyKey: "k" }) as { data: any };
    expect(a.data.id).toBe(b.data.id);
    expect(s.tickets.length).toBe(4);
  });
  it("review updates status", () => {
    const r = operations.review_access_request(createStore(), { id: "ACC-1", decision: "approve" }) as { data: any };
    expect(r.data.status).toBe("approved");
  });
});
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run tests/mcp-tools.test.ts`
Expected: PASS (5).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/seeds.ts src/mcp/operations.ts tests/mcp-tools.test.ts && git commit -m "feat: add mock seeds + pure tool operations + tests"
```

---

## Task 4: ServalMCP McpAgent (`src/mcp/serval.ts`)

**Files:** Create `src/mcp/serval.ts`

- [ ] **Step 1: Write the McpAgent**

```ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "./seeds";
import { createStore } from "./seeds";
import { operations } from "./operations";
import type { OpResult } from "./operations";

type State = { store: Store };

function toResult(r: OpResult) {
  if ("error" in r) return { content: [{ type: "text" as const, text: r.error }], isError: true };
  return { content: [{ type: "text" as const, text: JSON.stringify(r.data) }], structuredContent: r.data as Record<string, unknown> };
}

export class ServalMCP extends McpAgent<Env, State> {
  server = new McpServer({ name: "serval", version: "1.0.0" });
  initialState: State = { store: createStore() };

  // run a pure op against current state, persist if it mutated
  private exec(name: keyof typeof operations, args: any, mutates: boolean) {
    const store = this.state.store;
    const r = (operations[name] as (s: Store, a: any) => OpResult)(store, args ?? {});
    if (mutates && !("error" in r)) this.setState({ store });
    return toResult(r);
  }

  async init() {
    const read = { readOnlyHint: true };
    const write = { readOnlyHint: false, idempotentHint: true };
    const S = this.server;

    S.registerTool("list_tickets", { description: "List all IT tickets.", inputSchema: {}, annotations: read }, async () => this.exec("list_tickets", {}, false));
    S.registerTool("get_ticket", { description: "Get one ticket by id.", inputSchema: { id: z.string().describe("e.g. TCK-1001") }, annotations: read }, async (a) => this.exec("get_ticket", a, false));
    S.registerTool("update_ticket", { description: "Update a ticket status/priority.", inputSchema: { id: z.string(), status: z.enum(["open", "pending", "resolved"]).optional(), priority: z.enum(["low", "medium", "high", "urgent"]).optional() }, annotations: write }, async (a) => this.exec("update_ticket", a, true));
    S.registerTool("post_message", { description: "Post an agent reply on a ticket.", inputSchema: { id: z.string(), body: z.string() }, annotations: write }, async (a) => this.exec("post_message", a, true));
    S.registerTool("list_access_requests", { description: "List JIT access requests.", inputSchema: {}, annotations: read }, async () => this.exec("list_access_requests", {}, false));
    S.registerTool("get_access_request", { description: "Get one access request by id.", inputSchema: { id: z.string() }, annotations: read }, async (a) => this.exec("get_access_request", a, false));
    S.registerTool("review_access_request", { description: "Set an access request decision.", inputSchema: { id: z.string(), decision: z.enum(["approve", "deny", "escalate"]) }, annotations: write }, async (a) => this.exec("review_access_request", a, true));
    S.registerTool("create_access_request", { description: "Create a JIT access request.", inputSchema: { userId: z.string(), resource: z.string(), scope: z.enum(["read", "write", "admin"]), isProduction: z.boolean().optional(), idempotencyKey: z.string().optional() }, annotations: write }, async (a) => this.exec("create_access_request", a, true));
    S.registerTool("create_ticket", { description: "Create an IT ticket.", inputSchema: { subject: z.string(), requester: z.string(), priority: z.enum(["low", "medium", "high", "urgent"]).optional(), idempotencyKey: z.string().optional() }, annotations: write }, async (a) => this.exec("create_ticket", a, true));
    S.registerTool("get_user", { description: "Look up a user by id, email, or name.", inputSchema: { id: z.string() }, annotations: read }, async (a) => this.exec("get_user", a, false));
    S.registerTool("list_workflows", { description: "List automation workflows.", inputSchema: {}, annotations: read }, async () => this.exec("list_workflows", {}, false));
    S.registerTool("run_workflow", { description: "Run a workflow for a subject user.", inputSchema: { id: z.string(), subjectUserId: z.string() }, annotations: write }, async (a) => this.exec("run_workflow", a, true));
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. (If `McpAgent` generic arity differs in the installed `agents`, adjust the `<Env, State>` params per the installed types.)

- [ ] **Step 3: Commit**

```bash
git add src/mcp/serval.ts && git commit -m "feat: add ServalMCP McpAgent (12 tools, stateful seeds)"
```

---

## Task 5: Worker entry + MCP route (`src/index.ts`)

**Files:** Create `src/index.ts`

This first version wires routing and the public MCP endpoint so we can validate the MCP server with Inspector before adding agents.

- [ ] **Step 1: Write the entry**

```ts
import { routeAgentRequest } from "agents";
import { ServalMCP } from "./mcp/serval";

export { ServalMCP };
// Agent exports are added in later tasks:
export { SupervisorAgent } from "./agents/supervisor";
export { TriageAgent } from "./agents/triage";
export { AccessReviewAgent } from "./agents/access-review";
export { OnboardingAgent } from "./agents/onboarding";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Public mock Serval MCP endpoint (Streamable HTTP) for Inspector/Claude.
    if (url.pathname.startsWith("/mcp")) {
      return ServalMCP.serve("/mcp", { binding: "ServalMCP" }).fetch(request, env, ctx);
    }

    // Run a scenario through the supervisor and stream SSE (added in Task 9).
    if (url.pathname === "/api/run") {
      const { runScenario } = await import("./agents/run");
      return runScenario(request, env);
    }

    // Agents SDK routes (/agents/...).
    const routed = await routeAgentRequest(request, env, { cors: true });
    if (routed) return routed;

    // Static assets (index.html) are served by the ASSETS binding automatically.
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

> The `./agents/*` imports are created in Tasks 7–9. To validate the MCP server *now*, temporarily comment the four agent `export` lines and the `/api/run` block, run the checks below, then restore them.

- [ ] **Step 2: Start dev server**

Create `.dev.vars` from `.dev.vars.example` (set `ANTHROPIC_API_KEY`, `CF_ACCOUNT_ID`, `GATEWAY_ID`). Run: `npx wrangler dev`
Expected: server on `http://localhost:8787` (or `:8788`). No startup errors.

- [ ] **Step 3: Validate the MCP server with Inspector**

Run (new terminal): `npx @modelcontextprotocol/inspector@latest`
In the UI: Transport = **Streamable HTTP**, URL = `http://localhost:8787/mcp`. Connect → list tools.
Expected: 12 tools listed; calling `list_tickets` returns 3 tickets; `get_ticket {id:"TCK-ERROR"}` returns an `isError` result. Restore any commented lines after.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts && git commit -m "feat: add Worker entry + public ServalMCP /mcp route"
```

---

## Task 6: Anthropic tool-loop + MCP tool conversion

**Files:** Create `src/lib/mcp-tools.ts`, `src/lib/anthropic.ts`, extend `tests/mcp-tools.test.ts`

- [ ] **Step 1: Write `src/lib/mcp-tools.ts`**

```ts
// Minimal shapes we rely on from the MCP client / Anthropic API.
export interface McpToolDef { name: string; description?: string; inputSchema?: Record<string, unknown>; }
export interface AnthropicTool { name: string; description: string; input_schema: Record<string, unknown>; }

/** Convert MCP tool defs to Anthropic tools, filtered to an allowlist of bare names. */
export function toAnthropicTools(mcpTools: McpToolDef[], allow: string[]): AnthropicTool[] {
  const allowed = new Set(allow);
  return mcpTools
    .filter((t) => allowed.has(bareName(t.name)))
    .map((t) => ({
      name: bareName(t.name),
      description: t.description ?? bareName(t.name),
      input_schema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
}

/** MCP clients may namespace tools as `server.tool` or `server__tool`; normalize. */
export function bareName(name: string): string {
  const parts = name.split(/__|\./);
  return parts[parts.length - 1] ?? name;
}
```

- [ ] **Step 2: Add conversion tests to `tests/mcp-tools.test.ts`**

Append:
```ts
import { toAnthropicTools, bareName } from "../src/lib/mcp-tools";

describe("MCP→Anthropic tool conversion", () => {
  const defs = [
    { name: "serval.list_tickets", description: "List", inputSchema: { type: "object", properties: {} } },
    { name: "serval.create_ticket", description: "Create", inputSchema: { type: "object", properties: { subject: { type: "string" } } } },
  ];
  it("normalizes namespaced names", () => {
    expect(bareName("serval.list_tickets")).toBe("list_tickets");
    expect(bareName("serval__create_ticket")).toBe("create_ticket");
  });
  it("filters to the allowlist and maps schema", () => {
    const tools = toAnthropicTools(defs, ["list_tickets"]);
    expect(tools.length).toBe(1);
    expect(tools[0]!.name).toBe("list_tickets");
    expect(tools[0]!.input_schema).toHaveProperty("properties");
  });
});
```

- [ ] **Step 3: Run — expect PASS**

Run: `npx vitest run tests/mcp-tools.test.ts`
Expected: PASS (operations 5 + conversion 2).

- [ ] **Step 4: Write `src/lib/anthropic.ts`** (AI-Gateway client + tool loop)

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicTool } from "./mcp-tools";

export function makeAnthropic(env: Env): Anthropic {
  const base = env.CF_ACCOUNT_ID && env.GATEWAY_ID
    ? `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.GATEWAY_ID}/anthropic`
    : undefined; // fall back to direct Anthropic if gateway vars are absent
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: base });
}

export interface ToolCall { name: string; input: Record<string, unknown>; }
export type CallTool = (name: string, input: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

export interface LoopResult { finalText: string; calls: { name: string; ok: boolean }[]; }

/** Run a Claude tool-use loop. `callTool` executes a tool and returns its text result. */
export async function runToolLoop(opts: {
  client: Anthropic;
  model: string;
  system: string;
  userPrompt: string;
  tools: AnthropicTool[];
  callTool: CallTool;
  maxSteps?: number;
  maxTokens?: number;
}): Promise<LoopResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.userPrompt }];
  const calls: { name: string; ok: boolean }[] = [];
  const maxSteps = opts.maxSteps ?? 8;

  for (let step = 0; step < maxSteps; step++) {
    const res = await opts.client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      tools: opts.tools as unknown as Anthropic.Tool[],
      messages,
    });
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      return { finalText: text, calls };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const out = await opts.callTool(block.name, block.input as Record<string, unknown>);
      calls.push({ name: block.name, ok: !out.isError });
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: out.text, is_error: out.isError });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return { finalText: "(stopped: max steps reached)", calls };
}
```

> SDK-shape note: `@anthropic-ai/sdk` block/param type names (`MessageParam`, `TextBlock`, `ToolResultBlockParam`, `Tool`, `stop_reason: "tool_use"`) follow the current SDK. If types differ, adjust here only.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.
```bash
git add src/lib/mcp-tools.ts src/lib/anthropic.ts tests/mcp-tools.test.ts && git commit -m "feat: add Anthropic AI-Gateway tool-loop + MCP tool conversion"
```

---

## Task 7: Base specialist + 3 specialist agents

**Files:** Create `src/lib/trace.ts`, `src/agents/base-specialist.ts`, `src/agents/triage.ts`, `src/agents/access-review.ts`, `src/agents/onboarding.ts`

- [ ] **Step 1: `src/lib/trace.ts`**

```ts
export type TraceName = "run_start" | "delegate" | "tool_call" | "tool_result" | "synthesis" | "done" | "error";
export interface TraceEvent { name: TraceName; agent?: string; tool?: string; detail?: string; data?: unknown; }

/** Encode a trace event as an SSE frame. */
export function sse(ev: TraceEvent): string {
  return `event: ${ev.name}\ndata: ${JSON.stringify(ev)}\n\n`;
}
```

- [ ] **Step 2: `src/agents/base-specialist.ts`**

```ts
import { Agent } from "agents";
import { makeAnthropic, runToolLoop } from "../lib/anthropic";
import { toAnthropicTools, bareName } from "../lib/mcp-tools";
import type { McpToolDef } from "../lib/mcp-tools";
import { FindingSchema } from "../lib/schemas";
import type { Finding } from "../lib/schemas";

export interface SpecialistConfig {
  id: "triage" | "access-review" | "onboarding";
  model: (env: Env) => string;
  allow: string[];          // bare tool names this specialist may use
  system: string;
}

/** Connect to Serval MCP (mock binding or live URL) and return the raw tool list + a caller. */
async function connectServal(agent: Agent<Env>) {
  const env = agent.env;
  if (env.SERVAL_MODE === "live") {
    await agent.addMcpServer("serval", env.SERVAL_MCP_URL, {
      transport: { headers: { Authorization: `Bearer ${env.SERVAL_TOKEN}` } },
    } as any);
  } else {
    await agent.addMcpServer("serval", env.ServalMCP as any); // v0.6.0 RPC transport via DO binding
  }
  const tools = (await agent.mcp.listTools()) as unknown as McpToolDef[];
  const callTool = async (name: string, input: Record<string, unknown>) => {
    const res: any = await agent.mcp.callTool({ serverId: "serval", name, arguments: input } as any);
    const text = (res?.content ?? []).map((c: any) => c.text ?? "").join("\n");
    return { text: text || JSON.stringify(res?.structuredContent ?? {}), isError: Boolean(res?.isError) };
  };
  return { tools, callTool };
}

/** Run a specialist: tool-loop against scoped Serval tools, parse a Finding. */
export async function runSpecialist(agent: Agent<Env>, cfg: SpecialistConfig, taskSpec: string): Promise<Finding> {
  const { tools, callTool } = await connectServal(agent);
  const anthropicTools = toAnthropicTools(tools.map((t) => ({ ...t, name: bareName(t.name) })), cfg.allow);
  const client = makeAnthropic(agent.env);

  const { finalText, calls } = await runToolLoop({
    client, model: cfg.model(agent.env), system: cfg.system, userPrompt: taskSpec,
    tools: anthropicTools, callTool, maxSteps: 10, maxTokens: 1500,
  });

  // Extract the trailing ```json finding; fall back to a synthesized one.
  const m = finalText.match(/```json\s*([\s\S]*?)```/);
  let finding: Finding;
  try {
    finding = FindingSchema.parse(JSON.parse(m ? m[1]! : finalText));
  } catch {
    finding = { agent: cfg.id, summary: finalText.slice(0, 600), actions: calls.map((c) => ({ tool: c.name, target: "-", result: c.ok ? "ok" : "error" })), references: [] };
  }
  return finding;
}

const FINDING_FMT = `End with a single \`\`\`json block: {"agent":"<id>","summary":"...","actions":[{"tool":"...","target":"...","result":"..."}],"references":["..."]}. One-paragraph summary; IDs in references, never raw payloads.`;
export const FINDING_FORMAT = FINDING_FMT;
```

- [ ] **Step 3: `src/agents/triage.ts`**

```ts
import { Agent } from "agents";
import { runSpecialist, FINDING_FORMAT } from "./base-specialist";
import type { SpecialistConfig } from "./base-specialist";

const CFG: SpecialistConfig = {
  id: "triage",
  model: (env) => env.MODEL_HAIKU,
  allow: ["list_tickets", "get_ticket", "update_ticket", "post_message"],
  system: [
    "You are the Triage specialist for an IT help desk.",
    "Classify and prioritize tickets, set status/priority, and draft concise replies.",
    "Only touch tickets in scope. Never invent ids — list/get first.",
    FINDING_FORMAT,
  ].join("\n"),
};

export class TriageAgent extends Agent<Env> {
  async run(taskSpec: string) {
    return runSpecialist(this, CFG, taskSpec);
  }
}
```

- [ ] **Step 4: `src/agents/access-review.ts`** (uses the policy)

```ts
import { Agent } from "agents";
import { runSpecialist, FINDING_FORMAT } from "./base-specialist";
import type { SpecialistConfig } from "./base-specialist";
import { decideAccess } from "../policy/access-policy";

const CFG: SpecialistConfig = {
  id: "access-review",
  model: (env) => env.MODEL_SONNET,
  allow: ["list_access_requests", "get_access_request", "get_user", "review_access_request"],
  system: [
    "You are the Access-Review specialist.",
    "For each pending request in scope: get the request and requester, then decide and record it.",
    "You MUST follow the deterministic policy: deny if requester inactive; escalate admin or production grants; approve low-risk reads for active users. Never approve admin/production yourself.",
    FINDING_FORMAT,
  ].join("\n"),
};

export class AccessReviewAgent extends Agent<Env> {
  async run(taskSpec: string) {
    // The deterministic policy is available for callers/tests; the agent is instructed to mirror it.
    void decideAccess;
    return runSpecialist(this, CFG, taskSpec);
  }
}
```

> Optional hardening (post-PoC): expose `decideAccess` as a local Anthropic tool so the model calls it directly rather than mirroring it in the prompt. Kept prompt-mirrored for PoC simplicity; the deterministic function remains the source of truth and is unit-tested.

- [ ] **Step 5: `src/agents/onboarding.ts`**

```ts
import { Agent } from "agents";
import { runSpecialist, FINDING_FORMAT } from "./base-specialist";
import type { SpecialistConfig } from "./base-specialist";

const CFG: SpecialistConfig = {
  id: "onboarding",
  model: (env) => env.MODEL_SONNET,
  allow: ["get_user", "create_ticket", "create_access_request", "list_workflows", "run_workflow"],
  system: [
    "You are the Onboarding specialist.",
    "Given an employee: look them up, create an onboarding ticket, request baseline (read) access to standard tools, and run the Standard Onboarding workflow.",
    "Use an idempotencyKey per create so retries are safe.",
    FINDING_FORMAT,
  ].join("\n"),
};

export class OnboardingAgent extends Agent<Env> {
  async run(taskSpec: string) {
    return runSpecialist(this, CFG, taskSpec);
  }
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean. (Adjust `agent.mcp` / `addMcpServer` calls if the installed `agents` API differs — see the SDK-shape note.)
```bash
git add src/lib/trace.ts src/agents/base-specialist.ts src/agents/triage.ts src/agents/access-review.ts src/agents/onboarding.ts && git commit -m "feat: add specialist agents (scoped MCP tool-loops → Finding)"
```

---

## Task 8: Supervisor agent + scenarios (`src/agents/supervisor.ts`, `src/lib/scenarios.ts`, `src/agents/run.ts`)

**Files:** Create `src/lib/scenarios.ts`, `src/agents/supervisor.ts`, `src/agents/run.ts`

- [ ] **Step 1: `src/lib/scenarios.ts`**

```ts
export interface Scenario { prompt: string; specialists: ("triage" | "access-review" | "onboarding")[]; }

export const SCENARIOS: Record<string, Scenario> = {
  triage: { prompt: "Triage and prioritize all open IT tickets, and reply to the highest-priority one.", specialists: ["triage"] },
  access: { prompt: "Review all pending just-in-time access requests and record decisions per policy.", specialists: ["access-review"] },
  onboard: { prompt: "Onboard the new employee Jane Doe.", specialists: ["onboarding"] },
  fanout: { prompt: "Onboard Jane Doe and review her pending access requests.", specialists: ["onboarding", "access-review"] },
};
```

> The supervisor can also plan dynamically (below); `SCENARIOS` provides the demo's named buttons and a deterministic specialist set so the console is predictable.

- [ ] **Step 2: `src/agents/supervisor.ts`**

```ts
import { Agent, getAgentByName } from "agents";
import { sse } from "../lib/trace";
import type { TraceEvent } from "../lib/trace";
import type { Finding, OrchestratorResult } from "../lib/schemas";

const SUPERVISOR_SYSTEM = `You are the Orchestrator for an IT operations team. You coordinate specialist
subagents (triage, access-review, onboarding); you do not call Serval tools yourself.
Apply a simplicity gate: delegate to ONE specialist for a single-domain request; fan out only
when the request genuinely spans domains. Synthesize specialist findings into one clear answer.`;

type Spec = "triage" | "access-review" | "onboarding";

export class SupervisorAgent extends Agent<Env> {
  /** Run a scenario; returns an SSE ReadableStream of trace events.
   *  Not `async`: it constructs and returns the streaming Response synchronously
   *  (the ReadableStream's start() callback does the async work). Over RPC the
   *  caller still awaits it. */
  stream(prompt: string, specialists: Spec[]): Response {
    const env = this.env;
    const enc = new TextEncoder();
    const supervisor = this;

    const body = new ReadableStream({
      async start(controller) {
        const emit = (ev: TraceEvent) => controller.enqueue(enc.encode(sse(ev)));
        try {
          emit({ name: "run_start", detail: prompt });
          await supervisor.setState({ plan: { prompt, specialists }, status: "running" });

          // 4-field task spec per specialist.
          const taskSpec = (s: Spec) =>
            `OBJECTIVE: handle this request as the ${s} specialist: "${prompt}".\n` +
            `OUTPUT: a single JSON finding (summary, actions, references).\n` +
            `TOOLS: only your scoped Serval tools.\n` +
            `BOUNDARIES: do not act outside the ${s} domain.`;

          // Fan out in parallel via RPC.
          specialists.forEach((s) => emit({ name: "delegate", agent: s }));
          const stubs: Record<Spec, any> = {
            triage: env.Triage, "access-review": env.AccessReview, onboarding: env.Onboarding,
          };
          const findings = await Promise.all(
            specialists.map(async (s) => {
              const stub = await getAgentByName(stubs[s], `${s}-${prompt.length}`);
              const finding = (await stub.run(taskSpec(s))) as Finding;
              for (const a of finding.actions) emit({ name: "tool_call", agent: s, tool: a.tool, detail: a.target });
              emit({ name: "tool_result", agent: s, detail: `${finding.actions.length} actions` });
              return finding;
            }),
          );

          emit({ name: "synthesis" });
          const result: OrchestratorResult = {
            answer: findings.map((f) => `• ${f.summary}`).join("\n"),
            specialistsUsed: specialists,
            findings,
          };
          await supervisor.setState({ plan: { prompt, specialists }, status: "done", result });
          emit({ name: "done", data: result });
        } catch (e) {
          emit({ name: "error", detail: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  }
}
```

> Synthesis here is a deterministic merge of specialist summaries (cheap, predictable for the demo). To use a final Claude synthesis call instead, swap the `result.answer` line for a `runToolLoop`/`messages.create` call — kept deterministic for PoC cost/latency.

- [ ] **Step 3: `src/agents/run.ts`** (route helper used by `index.ts`)

```ts
import { getAgentByName } from "agents";
import { SCENARIOS } from "../lib/scenarios";

export async function runScenario(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("scenario") ?? "triage";
  const scenario = SCENARIOS[key] ?? SCENARIOS.triage;
  const supervisor = await getAgentByName(env.Supervisor, `run-${key}`);
  return (await supervisor.stream(scenario.prompt, scenario.specialists)) as Response;
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean. (If `getAgentByName` stub typing rejects `.stream`/`.run`, cast the stub to `any` or type the methods via the DO namespace generic.)
```bash
git add src/lib/scenarios.ts src/agents/supervisor.ts src/agents/run.ts && git commit -m "feat: add supervisor (RPC fan-out + SSE) and scenario runner"
```

---

## Task 9: Verify end-to-end orchestration (no new files; uses Task 5 entry)

- [ ] **Step 1: Ensure all agent exports are active in `src/index.ts`**

Confirm the four `export { ... }` agent lines and the `/api/run` block from Task 5 are present (uncommented).

- [ ] **Step 2: Typecheck + dev**

Run: `npm run typecheck && npx wrangler dev`
Expected: clean typecheck; dev server starts; `wrangler types` has no missing bindings.

- [ ] **Step 3: Stream a scenario (requires API key + AI Gateway vars)**

Run: `curl -N "http://localhost:8787/api/run?scenario=triage"`
Expected: SSE frames stream: `event: run_start` → `event: delegate` (triage) → `event: tool_call` (list_tickets, …) → `event: tool_result` → `event: synthesis` → `event: done` with a JSON answer.

Then: `curl -N "http://localhost:8787/api/run?scenario=fanout"`
Expected: TWO `delegate` events (onboarding + access-review), interleaved tool calls, one `done`.

> If no API key/gateway is configured in this environment, mark streamed-run steps as pending user verification; the SSE wiring and routing are still typecheck-verified.

- [ ] **Step 4: Commit (if any fixes were needed)**

```bash
git add -A && git commit -m "fix: end-to-end orchestration wiring" --allow-empty
```

---

## Task 10: Visual console (`src/public/index.html`)

**Files:** Create `src/public/index.html`

- [ ] **Step 1: Write the page**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Serval Multi-Agent IT Orchestrator</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..700&family=Hanken+Grotesk:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root{--bg:#fff;--line:#e5e7eb;--ink:#1a1a1a;--muted:#6b7280;--accent:#06b6d4;--ok:#10b981;--err:#c0392b;
    --display:'Bricolage Grotesque',system-ui,sans-serif;--body:'Hanken Grotesk',system-ui,sans-serif;--mono:'IBM Plex Mono',ui-monospace,monospace;--radius:10px}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);line-height:1.5}
  .wrap{max-width:1100px;margin:0 auto;padding:0 24px}
  h1,h2{font-family:var(--display);letter-spacing:-.02em;margin:0 0 8px}
  header{padding:64px 0 32px;border-bottom:1px solid var(--line)}
  header p{color:var(--muted);max-width:62ch;font-size:18px}
  section{padding:40px 0;border-bottom:1px solid var(--line)}
  .accent{color:var(--accent)}
  .btn{font:inherit;font-size:15px;border:1px solid var(--line);background:#fff;padding:10px 16px;border-radius:var(--radius);cursor:pointer}
  .btn:hover{border-color:var(--accent)}
  .scenarios{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
  .console{container-type:inline-size;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
  .console-head{display:flex;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);background:#fafafa}
  .status{font-family:var(--mono);font-size:13px;color:var(--muted)}
  .console:has(.row[data-state="running"]) .status{color:var(--accent)}
  .log{font-family:var(--mono);font-size:13px;max-height:380px;overflow:auto;padding:12px 16px;margin:0}
  .log:not(:has(.row))::after{content:"Pick a scenario to run the orchestrator…";color:var(--muted)}
  .row{padding:2px 0;white-space:pre-wrap;animation:slide 160ms ease-out}
  .row[data-level="delegate"]{color:var(--accent)} .row[data-level="tool_result"]{color:var(--muted)}
  .row[data-level="done"]{color:var(--ok);font-weight:600} .row[data-level="error"]{color:var(--err);font-weight:600}
  @keyframes slide{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
  pre.diagram{font-family:var(--mono);font-size:12.5px;background:#fafafa;border:1px solid var(--line);border-radius:var(--radius);padding:16px;overflow:auto}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)} th{font-family:var(--mono);font-weight:500;color:var(--muted)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
  .card{border:1px solid var(--line);border-radius:var(--radius);padding:14px}
  .card h3{font-family:var(--mono);font-size:13px;margin:0 0 6px;color:var(--accent)}
  footer{padding:32px 0;color:var(--muted);font-size:14px}
  @container (max-width:520px){.console-head{flex-direction:column;gap:4px}}
  @media (prefers-reduced-motion:reduce){.row{animation:none}}
</style>
</head>
<body>
<header><div class="wrap">
  <h1>Serval <span class="accent">Multi-Agent</span> IT Orchestrator</h1>
  <p>A supervisor Durable Object routes IT work to scoped specialist agents that operate Serval over MCP — all on Cloudflare. Run a scenario to watch the orchestration stream live.</p>
</div></header>

<section><div class="wrap">
  <h2>Live demo console</h2>
  <div class="scenarios">
    <button class="btn" data-s="triage">Triage tickets</button>
    <button class="btn" data-s="access">Review access</button>
    <button class="btn" data-s="onboard">Onboard employee</button>
    <button class="btn" data-s="fanout">Fan-out: onboard + review</button>
  </div>
  <div class="console">
    <div class="console-head"><strong>orchestration trace</strong><span class="status" id="status">idle</span></div>
    <div class="log" id="log" role="log" aria-live="polite"></div>
  </div>
</div></section>

<section><div class="wrap">
  <h2>Architecture (Cloudflare)</h2>
  <pre class="diagram">  Static Assets (this page) ──SSE──► browser
        │ /api/run?scenario=…
        ▼
  SupervisorAgent (Durable Object, opus-4-8)
        │ getAgentByName() RPC · Promise.all fan-out
   ┌────┴──────┬───────────────┐
   ▼           ▼               ▼
 Triage    AccessReview    Onboarding   (Durable Objects, scoped tools)
 haiku       sonnet          sonnet      each runs its own Claude tool-loop
   └───────────┴───────────────┘  this.mcp (RPC)
               ▼
        ServalMCP (McpAgent DO)  — mock /mcp  ⇄  live Serval (Bearer)
        Claude via @anthropic-ai/sdk → Cloudflare AI Gateway</pre>
</div></section>

<section><div class="wrap">
  <h2>Agent registry</h2>
  <table>
    <thead><tr><th>Agent (DO)</th><th>Model</th><th>Role</th></tr></thead>
    <tbody>
      <tr><td>Supervisor</td><td>claude-opus-4-8</td><td>plan · delegate (RPC) · synthesize</td></tr>
      <tr><td>Triage</td><td>claude-haiku-4-5</td><td>classify · prioritize · reply</td></tr>
      <tr><td>Access-Review</td><td>claude-sonnet-4-6</td><td>evaluate JIT access vs policy</td></tr>
      <tr><td>Onboarding</td><td>claude-sonnet-4-6</td><td>tickets · access · workflow</td></tr>
    </tbody>
  </table>
</div></section>

<section><div class="wrap">
  <h2>Cutting-edge stack</h2>
  <div class="grid">
    <div class="card"><h3>Cloudflare Agents</h3>Supervisor + specialists as Durable Objects; RPC fan-out.</div>
    <div class="card"><h3>McpAgent</h3>Serval mock as a remote Streamable-HTTP MCP server.</div>
    <div class="card"><h3>AI Gateway</h3>Claude via @anthropic-ai/sdk — caching, retries, observability.</div>
    <div class="card"><h3>MCP 2025-11-25</h3>outputSchema + structuredContent, annotations, isError.</div>
    <div class="card"><h3>Context isolation</h3>Each specialist its own DO + scoped tools.</div>
    <div class="card"><h3>Edge SSE</h3>ReadableStream trace, no duration limit.</div>
  </div>
</div></section>

<footer><div class="wrap">Mock backend · deploys on Cloudflare (wrangler deploy) · real Serval one env var away.</div></footer>

<script type="module">
  const log = document.getElementById("log"), status = document.getElementById("status");
  let es = null;
  const add = (level, text) => {
    const row = document.createElement("div");
    row.className = "row"; row.dataset.level = level;
    row.dataset.state = (level === "done" || level === "error") ? "done" : "running";
    row.textContent = text;
    const render = () => { log.appendChild(row); log.scrollTop = log.scrollHeight; };
    document.startViewTransition ? document.startViewTransition(render) : render();
  };
  function run(s){
    if (es) es.close();
    log.replaceChildren(); status.textContent = "running " + s + "…";
    es = new EventSource("/api/run?scenario=" + encodeURIComponent(s));
    const on = (e, f) => es.addEventListener(e, (ev) => f(JSON.parse(ev.data)));
    on("run_start", d => add("delegate", "▶ " + d.detail));
    on("delegate", d => add("delegate", "  → delegate to " + d.agent));
    on("tool_call", d => add("tool_call", "    · " + d.tool + " (" + d.agent + ")" + (d.detail ? " " + d.detail : "")));
    on("tool_result", d => add("tool_result", "    · " + (d.agent||"") + " " + (d.detail||"")));
    on("synthesis", () => add("tool_result", "  ∑ synthesizing findings"));
    on("done", d => { add("done", "✓ done"); if (d.data?.answer) add("done", "\n" + d.data.answer); status.textContent = "complete"; es.close(); });
    on("error", d => { add("error", "✗ " + (d.detail||"error")); status.textContent = "error"; es.close(); });
  }
  for (const b of document.querySelectorAll(".btn[data-s]")) b.addEventListener("click", () => run(b.dataset.s));
</script>
</body>
</html>
```

- [ ] **Step 2: Verify the console (requires API key + gateway)**

Run: `npx wrangler dev` → open `http://localhost:8787/` → click **Fan-out: onboard + review**.
Expected: page served from Static Assets; trace pane streams `▶ run → delegate (onboarding) → delegate (access-review) → tool calls → ∑ → ✓ done` with a merged answer; status "complete".

> No API key here? Verify the page loads (`curl -s localhost:8787/ | head`) and mark the live run pending user verification.

- [ ] **Step 3: Commit**

```bash
git add src/public/index.html && git commit -m "feat: add Cloudflare Conduit-style visual console (SSE)"
```

---

## Task 11: Gated end-state evals (`tests/eval/scenarios.eval.ts`)

**Files:** Create `tests/eval/scenarios.eval.ts`

- [ ] **Step 1: Write the eval (pure-result assertions over the scenario map)**

```ts
import { describe, it, expect } from "vitest";
import { SCENARIOS } from "../../src/lib/scenarios";

const RUN = process.env.RUN_EVALS ? describe : describe.skip;

// Structural evals always run (cheap): the scenario map is correct.
describe("scenario routing map", () => {
  it("triage scenario routes only to triage", () => {
    expect(SCENARIOS.triage!.specialists).toEqual(["triage"]);
  });
  it("fanout routes to onboarding + access-review", () => {
    expect(SCENARIOS.fanout!.specialists).toEqual(expect.arrayContaining(["onboarding", "access-review"]));
  });
});

// End-state evals (need API key + a running orchestrator) — gated.
RUN("end-state evals (RUN_EVALS)", () => {
  it("placeholder for live end-state checks", () => {
    // Wire to a deployed/dev /api/run + an LLM-judge rubric on the final state.
    expect(true).toBe(true);
  });
});
```

> The structural evals guard the routing contract cheaply in CI; the gated block is where a live `/api/run` + LLM-judge rubric attaches once a dev/deploy URL is available (avoids requiring an API key in normal test runs).

- [ ] **Step 2: Run normal tests (evals skipped/structural only)**

Run: `npm test`
Expected: policy (5) + operations (5) + conversion (2) + scenario-map (2) pass; gated block skipped.

- [ ] **Step 3: Commit**

```bash
git add tests/eval/scenarios.eval.ts && git commit -m "test: add scenario-routing + gated end-state evals"
```

---

## Task 12: README + deploy + final verification

**Files:** Create `README.md`

- [ ] **Step 1: Write `README.md`**

````markdown
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
Open `http://localhost:8787/` and click a scenario. Inspect the mock MCP server at `/mcp` with `npx @modelcontextprotocol/inspector`.

## Deploy
```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put GATEWAY_ID
npx wrangler deploy
```

## Architecture
Supervisor (Claude Opus 4.8) → specialist Durable Objects via `getAgentByName()` RPC, parallel fan-out. Each specialist is scoped to a slice of Serval MCP tools and returns a distilled, schema-validated Finding. Live trace streams to the console over SSE. See `docs/superpowers/`.

## Real Serval
Set `SERVAL_MODE=live`, `SERVAL_MCP_URL`, `SERVAL_TOKEN` (workspace credentials). The specialists' MCP client targets real Serval instead of the mock binding; tool names/shapes are identical.
````

- [ ] **Step 2: Full verification sweep**

Run:
```bash
npm run typecheck && npm test && npx wrangler deploy --dry-run
```
Expected: typecheck clean; all unit tests pass; `--dry-run` validates the Worker bundles and the 5 DO migrations are recognized (no deploy performed).

- [ ] **Step 3: Commit**

```bash
git add README.md && git commit -m "docs: add README (run, deploy, architecture)"
```

---

## Done criteria

- `npm run typecheck` clean; `npm test` green (policy 5 · operations 5 · conversion 2 · routing 2).
- `npx wrangler deploy --dry-run` validates the Worker + 5 Durable Object migrations + assets.
- `wrangler dev`: MCP Inspector lists 12 tools at `/mcp`; the console at `/` streams a live multi-agent fan-out and synthesizes (with an API key + AI Gateway).
- The access policy is implemented by the user and its tests pass.
- Real-Serval swap is a pure env change (`SERVAL_MODE=live`).
- `npx wrangler deploy` ships it to Cloudflare.
```
</content>
