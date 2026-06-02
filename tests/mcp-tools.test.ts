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
  it("review updates status", () => {
    const r = operations.review_access_request(createStore(), { id: "ACC-1", decision: "approve" }) as { data: any };
    expect(r.data.status).toBe("approved");
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
