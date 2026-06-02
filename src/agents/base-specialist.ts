import { Agent } from "agents";
import { McpAgent } from "agents/mcp";
import { makeAnthropic, runToolLoop } from "../lib/anthropic";
import { toAnthropicTools, bareName } from "../lib/mcp-tools";
import type { McpToolDef } from "../lib/mcp-tools";
import { FindingSchema } from "../lib/schemas";
import type { Finding } from "../lib/schemas";
import type { MCPClientManager } from "agents/mcp/client";

export interface SpecialistConfig {
  id: "triage" | "access-review" | "onboarding";
  model: (env: Env) => string;
  allow: string[];          // bare tool names this specialist may use
  system: string;
}

/**
 * Connect to Serval MCP (mock DO binding or live URL) and return the raw tool list + a caller.
 *
 * Real agents@0.6.0 API:
 *   addMcpServer(name, binding: DurableObjectNamespace<McpAgent>)  — RPC / DO transport
 *   addMcpServer(name, url: string, options?: AddMcpServerOptions) — HTTP transport
 *   agent.mcp.listTools() → (Tool & { serverId: string })[]        — synchronous
 *   agent.mcp.callTool({ name, arguments, serverId })              — async, returns MCP content array
 *
 * env and mcp are passed explicitly to avoid accessing protected `agent.env` from outside the class.
 */
async function connectServal(env: Env, agent: Agent<Env>) {
  const serverId = "serval";

  if (env.SERVAL_MODE !== "mock") {
    // HTTP transport with Bearer auth (live or any non-mock value)
    await agent.addMcpServer(serverId, env.SERVAL_MCP_URL, {
      transport: { headers: { Authorization: `Bearer ${env.SERVAL_TOKEN}` } },
    });
  } else {
    // Mock mode: env.ServalMCP is a DurableObjectNamespace<McpAgent>
    await agent.addMcpServer(
      serverId,
      env.ServalMCP as unknown as DurableObjectNamespace<McpAgent>,
    );
  }

  const mcp: MCPClientManager = agent.mcp;

  // listTools() returns (Tool & { serverId: string })[] — synchronous
  const rawTools = mcp.listTools();

  // Map to our internal McpToolDef shape; keep only tools from this server
  const tools: McpToolDef[] = rawTools
    .filter((t) => t.serverId === serverId)
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));

  const callTool = async (name: string, input: Record<string, unknown>) => {
    const res = await mcp.callTool({ name, arguments: input, serverId } as any);
    // res.content is the MCP content array; extract text blocks
    const content = (res as any)?.content ?? [];
    const text = (content as Array<{ type: string; text?: string }>)
      .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
      .join("\n");
    const structured = (res as any)?.structuredContent;
    return {
      text: text || (structured != null ? JSON.stringify(structured) : ""),
      isError: Boolean((res as any)?.isError),
    };
  };

  return { tools, callTool };
}

/** Run a specialist: tool-loop against scoped Serval tools, parse a Finding. */
export async function runSpecialist(agent: Agent<Env>, cfg: SpecialistConfig, taskSpec: string, env: Env): Promise<Finding> {
  const { tools, callTool } = await connectServal(env, agent);
  const anthropicTools = toAnthropicTools(tools.map((t) => ({ ...t, name: bareName(t.name) })), cfg.allow);
  const client = makeAnthropic(env);

  const { finalText, calls } = await runToolLoop({
    client, model: cfg.model(env), system: cfg.system, userPrompt: taskSpec,
    tools: anthropicTools, callTool, maxSteps: 10, maxTokens: 1500,
  });

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
