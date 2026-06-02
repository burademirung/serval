import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicTool } from "./mcp-tools";

export function makeAnthropic(env: Pick<Env, "ANTHROPIC_API_KEY" | "CF_ACCOUNT_ID" | "GATEWAY_ID">): Anthropic {
  const base = env.CF_ACCOUNT_ID && env.GATEWAY_ID
    ? `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.GATEWAY_ID}/anthropic`
    : undefined; // fall back to direct Anthropic if gateway vars are absent
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: base });
}

export function effortSpread(effort?: string): Record<string, unknown> {
  return effort ? { output_config: { effort } } : {};
}

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
  effort?: string;
  signal?: AbortSignal;
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
      // Optional reasoning-effort knob; only sent when configured (off by default).
      ...effortSpread(opts.effort),
    } as Anthropic.MessageCreateParamsNonStreaming, { signal: opts.signal });
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { finalText: text, calls };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const out = await opts.callTool(block.name, block.input as Record<string, unknown>);
      calls.push({ name: block.name, ok: !out.isError });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: out.text,
        is_error: out.isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return { finalText: "(stopped: max steps reached)", calls };
}
