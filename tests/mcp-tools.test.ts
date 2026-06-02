import { describe, it, expect } from "vitest";
import { createStore, ERROR_TICKET_ID } from "../src/mcp/seeds";
import { operations } from "../src/mcp/operations";
import { toAnthropicTools, bareName } from "../src/lib/mcp-tools";

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
  it("review records an agent decision that policy permits (deny)", () => {
    const r = operations.review_access_request(createStore(), { id: "ACC-1", decision: "deny" }) as { data: any };
    expect(r.data.status).toBe("denied");
    expect(r.data.enforced).toBeUndefined();
  });
  it("enforces policy: agent approve of non-read access is downgraded to escalate", () => {
    // ACC-1 is github WRITE for active USR-1 → policy says escalate (non-read).
    const r = operations.review_access_request(createStore(), { id: "ACC-1", decision: "approve" }) as { data: any };
    expect(r.data.status).toBe("escalated");
    expect(r.data.enforced).toBe(true);
    expect(r.data.policyDecision).toBe("escalate");
  });
  it("enforces policy: agent approve of admin/prod access is downgraded to escalate", () => {
    // ACC-2 is aws-prod ADMIN for active USR-1 → policy says escalate.
    const r = operations.review_access_request(createStore(), { id: "ACC-2", decision: "approve" }) as { data: any };
    expect(r.data.status).toBe("escalated");
    expect(r.data.enforced).toBe(true);
  });
});

describe("routing filter logic", () => {
  // Replicate the filter used inside route() to validate it standalone.
  const ALL_SPECS = ["triage", "access-review", "onboarding"] as const;
  type Spec = (typeof ALL_SPECS)[number];
  function filterSpecs(arr: string[]): Spec[] {
    return arr.filter((s): s is Spec => ALL_SPECS.includes(s as Spec));
  }

  it("keeps valid specialist names and drops unknown ones", () => {
    expect(filterSpecs(["triage", "unknown"])).toEqual(["triage"]);
  });
  it("returns empty array for empty input", () => {
    expect(filterSpecs([])).toEqual([]);
  });
  it("drops all unknown specialists", () => {
    expect(filterSpecs(["x", "y"])).toEqual([]);
  });
});

describe("create_access_request defaults", () => {
  it("always creates status pending", () => {
    const result = operations.create_access_request(createStore(), { userId: "USR-1", resource: "github", scope: "admin" }) as { data: any };
    expect(result.data.status).toBe("pending");
  });
});

describe("bareName edge cases", () => {
  it("returns flat name unchanged", () => {
    expect(bareName("flat")).toBe("flat");
  });
  it("returns empty string for empty input", () => {
    expect(bareName("")).toBe("");
  });
});

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
