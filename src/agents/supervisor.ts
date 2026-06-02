import Anthropic from "@anthropic-ai/sdk";
import { Agent, getAgentByName } from "agents";
import { sse } from "../lib/trace";
import type { TraceEvent } from "../lib/trace";
import type { Finding, OrchestratorResult } from "../lib/schemas";
import { makeAnthropic, effortSpread } from "../lib/anthropic";

const SUPERVISOR_SYSTEM = `You are the Orchestrator for an IT operations team. You coordinate specialist
subagents (triage, access-review, onboarding); you do not call Serval tools yourself.
Apply a simplicity gate: delegate to ONE specialist for a single-domain request; fan out only
when the request genuinely spans domains. Synthesize specialist findings into one clear answer.`;

type Spec = "triage" | "access-review" | "onboarding";

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return Promise.race([p, new Promise<T>((res) => setTimeout(() => res(onTimeout()), ms))]);
}

/** Synthesize specialist findings into a final answer using the supervisor model
 *  (claude-opus-4-8). Falls back to a deterministic merge if the model call fails
 *  (e.g. no API key), so the pipeline degrades gracefully. */
async function synthesize(env: Env, prompt: string, findings: Finding[]): Promise<string> {
  const merge = () => findings.map((f) => `• ${f.summary}`).join("\n");
  try {
    const client = makeAnthropic(env);
    const res: Anthropic.Message = await client.messages.create({
      model: env.MODEL_SUPERVISOR,
      max_tokens: 700,
      system: SUPERVISOR_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `Original request: "${prompt}"\n\nSpecialist findings:\n` +
            findings.map((f) => `[${f.agent}] ${f.summary}`).join("\n") +
            `\n\nSynthesize one clear, concise answer for the user.`,
        },
      ],
      ...effortSpread(env.CLAUDE_EFFORT),
    } as Anthropic.MessageCreateParamsNonStreaming);
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
      .join("\n")
      .trim();
    return text || merge();
  } catch (e) {
    console.error("route/synthesize fallback:", e);
    return merge();
  }
}

const ALL_SPECS: Spec[] = ["triage", "access-review", "onboarding"];

/** Dynamic routing / simplicity gate: the supervisor model decides which specialists
 *  a request needs — ONE for single-domain, several only when it spans domains.
 *  Falls back to the provided default (the scenario's specialists) on any failure,
 *  so the demo stays predictable and the path degrades gracefully. */
async function route(env: Env, prompt: string, fallback: Spec[]): Promise<Spec[]> {
  try {
    const client = makeAnthropic(env);
    const res: Anthropic.Message = await client.messages.create({
      model: env.MODEL_ROUTER ?? env.MODEL_HAIKU,
      max_tokens: 120,
      system: SUPERVISOR_SYSTEM,
      messages: [{ role: "user", content:
        `Request: "${prompt}".\nAvailable specialists: triage, access-review, onboarding.\n` +
        `Return ONLY a JSON array of the specialists this request needs. Use exactly ONE for a ` +
        `single-domain request; include several ONLY if it genuinely spans domains.` }],
      ...effortSpread(env.CLAUDE_EFFORT),
    } as Anthropic.MessageCreateParamsNonStreaming);
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    const m = text.match(/\[[\s\S]*?\]/);
    if (m) {
      const arr = (JSON.parse(m[0]) as unknown[]).filter((s): s is Spec => ALL_SPECS.includes(s as Spec));
      const uniq = [...new Set(arr)];
      if (uniq.length && uniq.length <= ALL_SPECS.length) return uniq as Spec[];
    }
  } catch (e) {
    console.error("route/synthesize fallback:", e);
  }
  return fallback;
}

interface SupervisorState {
  plan?: { prompt: string; specialists: Spec[] };
  status?: string;
  result?: OrchestratorResult;
}

export class SupervisorAgent extends Agent<Env, SupervisorState> {
  initialState: SupervisorState = {};

  /** Run a scenario; returns an SSE ReadableStream of trace events.
   *  Not async: builds and returns the streaming Response synchronously. */
  stream(prompt: string, fallbackSpecialists: Spec[]): Response {
    const env = this.env;
    const enc = new TextEncoder();
    const supervisor = this;
    const traceId = crypto.randomUUID();

    let aborted = false;

    const body = new ReadableStream({
      async start(controller) {
        const emit = (ev: TraceEvent) =>
          controller.enqueue(enc.encode(sse({ ...ev, traceId })));
        try {
          emit({ name: "run_start", detail: prompt });

          if (aborted) { controller.close(); return; }

          // Simplicity gate: short-circuit routing for single-domain scenarios;
          // use a cheaper model for routing when multiple specialists are possible.
          const specialists = fallbackSpecialists.length <= 1 ? fallbackSpecialists : await route(env, prompt, fallbackSpecialists);
          supervisor.setState({ plan: { prompt, specialists }, status: "running" });

          if (aborted) { controller.close(); return; }

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

          const settled = await Promise.allSettled(
            specialists.map(async (s) => {
              // getAgentByName returns DurableObjectStub which exposes run() via RPC.
              // Cast to any because the untyped namespace stub doesn't carry .run() in TS types.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const stub: any = await getAgentByName(stubs[s]!, s);
              const finding = await withTimeout(
                stub.run(taskSpec(s)) as Promise<Finding>,
                45000,
                () => ({ agent: s, summary: `Specialist ${s} timed out`, actions: [], references: [] }),
              );
              for (const a of finding.actions)
                emit({ name: "tool_call", agent: s, tool: a.tool, detail: a.target });
              emit({ name: "tool_result", agent: s, detail: `${finding.actions.length} actions` });
              return finding;
            }),
          );

          const findings: Finding[] = settled.map((r, i) =>
            r.status === "fulfilled" ? r.value
            : { agent: specialists[i]!, summary: `Specialist ${specialists[i]} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`, actions: [], references: [] });

          if (aborted) { controller.close(); return; }

          emit({ name: "synthesis" });
          const result: OrchestratorResult = {
            answer: await synthesize(env, prompt, findings),
            specialistsUsed: specialists,
            findings,
          };
          supervisor.setState({ plan: { prompt, specialists }, status: "done", result });
          emit({ name: "done", data: result });
        } catch (e) {
          console.error("orchestration run failed:", e);
          emit({ name: "error", detail: "Run failed" });
        } finally {
          controller.close();
        }
      },
      cancel() {
        aborted = true;
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
