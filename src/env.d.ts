// Augments the wrangler-generated `Env` (worker-configuration.d.ts) with secret
// bindings. Secrets are NOT declared in wrangler.jsonc `vars`, so `wrangler types`
// does not include them. They are provided via `.dev.vars` locally and
// `wrangler secret put` in production. Declaration merging adds them to `Env` so
// all agent code typechecks against a complete environment.
interface Env {
  ANTHROPIC_API_KEY: string;
  CF_ACCOUNT_ID: string;
  GATEWAY_ID: string;
  SERVAL_MCP_URL: string;
  SERVAL_TOKEN: string;
  // Optional. When set, /mcp and /api/run require `Authorization: Bearer <token>`
  // (or `?token=`). Unset by default so the public demo stays open. For an org
  // deployment prefer Cloudflare Access + a Rate Limiting rule over this token.
  PUBLIC_ACCESS_TOKEN?: string;
  // Optional. Anthropic reasoning effort ("low"|"medium"|"high"|"xhigh"|"max"),
  // passed to messages.create when set. Off by default.
  CLAUDE_EFFORT?: string;
}
