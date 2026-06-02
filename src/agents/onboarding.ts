import { Agent } from "agents";
import { runSpecialist, FINDING_FORMAT } from "./base-specialist";
import type { SpecialistConfig } from "./base-specialist";

const CFG: SpecialistConfig = {
  id: "onboarding",
  model: (env) => env.MODEL_SONNET,
  allow: ["get_user", "create_ticket", "create_access_request", "list_workflows", "run_workflow"],
  system: [
    "You are the Onboarding specialist.",
    "Given an employee: look them up, create an onboarding ticket, request baseline (read) access to standard tools, and run the Standard Onboarding workflow.",
    "Use an idempotencyKey per create so retries are safe.",
    FINDING_FORMAT,
  ].join("\n"),
};

export class OnboardingAgent extends Agent<Env> {
  async run(taskSpec: string) {
    return runSpecialist(this, CFG, taskSpec, this.env);
  }
}
