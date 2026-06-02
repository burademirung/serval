import { routeAgentRequest } from "agents";
import { ServalMCP } from "./mcp/serval";

export { ServalMCP };
export { SupervisorAgent } from "./agents/supervisor";
export { TriageAgent } from "./agents/triage";
export { AccessReviewAgent } from "./agents/access-review";
export { OnboardingAgent } from "./agents/onboarding";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/mcp")) {
      return ServalMCP.serve("/mcp", { binding: "ServalMCP" }).fetch(request, env, ctx);
    }

    if (url.pathname === "/api/run") {
      const { runScenario } = await import("./agents/run");
      return runScenario(request, env);
    }

    const routed = await routeAgentRequest(request, env, { cors: true });
    if (routed) return routed;

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
