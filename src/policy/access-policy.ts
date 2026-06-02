export type AccessDecision = "approve" | "deny" | "escalate";

export interface AccessRequestContext {
  resource: string;
  scope: string;
  requesterActive: boolean;
  isProduction: boolean;
  isAdmin: boolean;
}

/**
 * Deterministic safety boundary for just-in-time access requests.
 * The Access-Review agent MUST defer to this; the LLM does not self-approve.
 *
 * Implement the ~8-line body. Consider: inactive requesters never get access;
 * admin or production grants are high-stakes (escalate to a human); low-risk reads
 * for active users can auto-approve. Order checks so the most restrictive wins.
 */
export function decideAccess(ctx: AccessRequestContext): { decision: AccessDecision; reason: string } {
  if (!ctx.requesterActive) return { decision: "deny", reason: "Requester is inactive" };
  if (ctx.isAdmin) return { decision: "escalate", reason: "Admin grant needs human approval" };
  if (ctx.isProduction) return { decision: "escalate", reason: "Production access needs human approval" };
  if (ctx.scope === "read") return { decision: "approve", reason: "Low-risk read for active user" };
  return { decision: "escalate", reason: "Non-read access requires review" };
}
