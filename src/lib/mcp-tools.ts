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
