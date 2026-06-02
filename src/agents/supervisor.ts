import { Agent, getAgentByName } from "agents";
import { sse } from "../lib/trace";
import type { TraceEvent } from "../lib/trace";
import type { Finding, OrchestratorResult } from "../lib/schemas";

const SUPERVISOR_SYSTEM = `You are the Orchestrator for an IT operations team. You coordinate specialist
subagents (triage, access-review, onboarding); you do not call Serval tools yourself.
Apply a simplicity gate: delegate to ONE specialist for a single-domain request; fan out only
when the request genuinely spans domains. Synthesize specialist findings into one clear answer.`;

// Ensure SUPERVISOR_SYSTEM is referenced to avoid unused-variable lint noise.
void SUPERVISOR_SYSTEM;

type Spec = "triage" | "access-review" | "onboarding";

interface SupervisorState {
  plan?: { prompt: string; specialists: Spec[] };
  status?: string;
  result?: OrchestratorResult;
}

export class SupervisorAgent extends Agent<Env, SupervisorState> {
  initialState: SupervisorState = {};

  /** Run a scenario; returns an SSE ReadableStream of trace events.
   *  Not async: builds and returns the streaming Response synchronously. */
  stream(prompt: string, specialists: Spec[]): Response {
    const env = this.env;
    const enc = new TextEncoder();
    const supervisor = this;

    const body = new ReadableStream({
      async start(controller) {
        const emit = (ev: TraceEvent) =>
          controller.enqueue(enc.encode(sse(ev)));
        try {
          emit({ name: "run_start", detail: prompt });
          supervisor.setState({ plan: { prompt, specialists }, status: "running" });

          const taskSpec = (s: Spec) =>
            `OBJECTIVE: handle this request as the ${s} specialist: "${prompt}".\n` +
            `OUTPUT: a single JSON finding (summary, actions, references).\n` +
            `TOOLS: only your scoped Serval tools.\n` +
            `BOUNDARIES: do not act outside the ${s} domain.`;

          specialists.forEach((s) => emit({ name: "delegate", agent: s }));

          // worker-configuration.d.ts declares DO namespaces as unparameterised
          // DurableObjectNamespace (= DurableObjectNamespace<undefined>). Cast to
          // the agent-typed form so getAgentByName accepts them; stub is then cast
          // to any for the RPC call (.run) which isn't in the static type.
          type AnyAgentNS = DurableObjectNamespace<Agent<Env>>;
          const stubs: Record<Spec, AnyAgentNS> = {
            triage: env.Triage as unknown as AnyAgentNS,
            "access-review": env.AccessReview as unknown as AnyAgentNS,
            onboarding: env.Onboarding as unknown as AnyAgentNS,
          };

          const findings = await Promise.all(
            specialists.map(async (s) => {
              // getAgentByName returns DurableObjectStub which exposes run() via RPC.
              // Cast to any because the untyped namespace stub doesn't carry .run() in TS types.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const stub: any = await getAgentByName(stubs[s]!, `${s}-${prompt.length}`);
              const finding = (await stub.run(taskSpec(s))) as Finding;
              for (const a of finding.actions)
                emit({ name: "tool_call", agent: s, tool: a.tool, detail: a.target });
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
          supervisor.setState({ plan: { prompt, specialists }, status: "done", result });
          emit({ name: "done", data: result });
        } catch (e) {
          emit({ name: "error", detail: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }
}
