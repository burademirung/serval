import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "./seeds";
import { createStore } from "./seeds";
import { operations } from "./operations";
import type { OpResult } from "./operations";

type State = { store: Store };

function toResult(r: OpResult) {
  if ("error" in r) {
    return { content: [{ type: "text" as const, text: r.error }], isError: true };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(r.data) }],
    structuredContent: r.data as Record<string, unknown>,
  };
}

export class ServalMCP extends McpAgent<Env, State> {
  // @ts-expect-error: The project uses @modelcontextprotocol/sdk@1.29.0 but agents@0.6.0
  // bundles @modelcontextprotocol/sdk@1.26.0. The two McpServer types are structurally
  // identical at runtime; TypeScript sees them as distinct due to a private field in the
  // Server base class. Suppressing here so that this.server retains full 1.29.0 typings
  // for registerTool calls in init().
  server = new McpServer({ name: "serval", version: "1.0.0" });
  initialState: State = { store: createStore() };

  private exec(name: keyof typeof operations, args: unknown, mutates: boolean) {
    const store = this.state.store;
    const r = (operations[name] as (s: Store, a: unknown) => OpResult)(store, args ?? {});
    if (mutates && !("error" in r)) this.setState({ store });
    return toResult(r);
  }

  async init() {
    const read = { readOnlyHint: true };
    const write = { readOnlyHint: false, idempotentHint: true };
    const S = this.server;

    S.registerTool(
      "list_tickets",
      { description: "List all IT tickets.", annotations: read },
      async () => this.exec("list_tickets", {}, false),
    );

    S.registerTool(
      "get_ticket",
      {
        description: "Get one ticket by id.",
        inputSchema: { id: z.string().describe("e.g. TCK-1001") },
        annotations: read,
      },
      async (a) => this.exec("get_ticket", a, false),
    );

    S.registerTool(
      "update_ticket",
      {
        description: "Update a ticket status/priority.",
        inputSchema: {
          id: z.string(),
          status: z.enum(["open", "pending", "resolved"]).optional(),
          priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        },
        annotations: write,
      },
      async (a) => this.exec("update_ticket", a, true),
    );

    S.registerTool(
      "post_message",
      {
        description: "Post an agent reply on a ticket.",
        inputSchema: { id: z.string(), body: z.string() },
        annotations: write,
      },
      async (a) => this.exec("post_message", a, true),
    );

    S.registerTool(
      "list_access_requests",
      { description: "List JIT access requests.", annotations: read },
      async () => this.exec("list_access_requests", {}, false),
    );

    S.registerTool(
      "get_access_request",
      {
        description: "Get one access request by id.",
        inputSchema: { id: z.string() },
        annotations: read,
      },
      async (a) => this.exec("get_access_request", a, false),
    );

    S.registerTool(
      "review_access_request",
      {
        description: "Set an access request decision.",
        inputSchema: { id: z.string(), decision: z.enum(["approve", "deny", "escalate"]) },
        annotations: write,
      },
      async (a) => this.exec("review_access_request", a, true),
    );

    S.registerTool(
      "create_access_request",
      {
        description: "Create a JIT access request.",
        inputSchema: {
          userId: z.string(),
          resource: z.string(),
          scope: z.enum(["read", "write", "admin"]),
          isProduction: z.boolean().optional(),
          idempotencyKey: z.string().optional(),
        },
        annotations: write,
      },
      async (a) => this.exec("create_access_request", a, true),
    );

    S.registerTool(
      "create_ticket",
      {
        description: "Create an IT ticket.",
        inputSchema: {
          subject: z.string(),
          requester: z.string(),
          priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
          idempotencyKey: z.string().optional(),
        },
        annotations: write,
      },
      async (a) => this.exec("create_ticket", a, true),
    );

    S.registerTool(
      "get_user",
      {
        description: "Look up a user by id, email, or name.",
        inputSchema: { id: z.string() },
        annotations: read,
      },
      async (a) => this.exec("get_user", a, false),
    );

    S.registerTool(
      "list_workflows",
      { description: "List automation workflows.", annotations: read },
      async () => this.exec("list_workflows", {}, false),
    );

    S.registerTool(
      "run_workflow",
      {
        description: "Run a workflow for a subject user.",
        inputSchema: { id: z.string(), subjectUserId: z.string() },
        annotations: write,
      },
      async (a) => this.exec("run_workflow", a, true),
    );
  }
}
