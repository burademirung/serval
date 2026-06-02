import { Agent, getAgentByName } from "agents";
import { SCENARIOS } from "../lib/scenarios";

export async function runScenario(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("scenario") ?? "triage";
  const fallback = SCENARIOS["triage"]!;
  const scenario = SCENARIOS[key] ?? fallback;
  // worker-configuration.d.ts uses unparameterised DurableObjectNamespace; cast to
  // agent-typed form for getAgentByName, then use any for the .stream() RPC call.
  type AnyAgentNS = DurableObjectNamespace<Agent<Env>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supervisor: any = await getAgentByName(
    env.Supervisor as unknown as AnyAgentNS,
    `run-${key}`,
  );
  return (await supervisor.stream(scenario.prompt, scenario.specialists)) as Response;
}
