export type TraceName = "run_start" | "delegate" | "tool_call" | "tool_result" | "synthesis" | "done" | "error";
export interface TraceEvent { name: TraceName; agent?: string; tool?: string; detail?: string; data?: unknown; }

/** Encode a trace event as an SSE frame. */
export function sse(ev: TraceEvent): string {
  return `event: ${ev.name}\ndata: ${JSON.stringify(ev)}\n\n`;
}
