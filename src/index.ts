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

    // Optional access gate. When PUBLIC_ACCESS_TOKEN is set, the state-mutating /mcp
    // endpoint and the LLM-spending /api/run endpoint require the token (Bearer header
    // or ?token=). Unset by default so the public demo stays open. For a real org
    // deployment prefer Cloudflare Access + a Rate Limiting rule in front of the Worker.
    const guard = env.PUBLIC_ACCESS_TOKEN;
    if (guard && (url.pathname.startsWith("/mcp") || url.pathname === "/api/run")) {
      const provided =
        (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") ||
        url.searchParams.get("token") ||
        "";
      if (provided !== guard) return new Response("Unauthorized", { status: 401 });
    }

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
