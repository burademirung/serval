export type TraceName = "run_start" | "delegate" | "tool_call" | "tool_result" | "synthesis" | "done" | "error";
/** One trace per run: `traceId` ties every event of a single orchestration together. */
export interface TraceEvent { name: TraceName; traceId?: string; agent?: string; tool?: string; detail?: string; data?: unknown; }

/** Encode a trace event as an SSE frame. */
export function sse(ev: TraceEvent): string {
  return `event: ${ev.name}\ndata: ${JSON.stringify(ev)}\n\n`;
}
