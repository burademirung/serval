import { z } from "zod";

export const FindingSchema = z.object({
  agent: z.enum(["triage", "access-review", "onboarding"]),
  summary: z.string(),
  actions: z.array(z.object({ tool: z.string(), target: z.string(), result: z.string() })).default([]),
  references: z.array(z.string()).default([]),
});
export type Finding = z.infer<typeof FindingSchema>;

export const OrchestratorResultSchema = z.object({
  answer: z.string(),
  specialistsUsed: z.array(z.enum(["triage", "access-review", "onboarding"])),
  findings: z.array(FindingSchema).default([]),
});
export type OrchestratorResult = z.infer<typeof OrchestratorResultSchema>;

export const AccessDecisionSchema = z.object({
  decision: z.enum(["approve", "deny", "escalate"]),
  reason: z.string(),
});
export type AccessDecisionResult = z.infer<typeof AccessDecisionSchema>;
