import { Agent } from "agents";
import { runSpecialist, FINDING_FORMAT } from "./base-specialist";
import type { SpecialistConfig } from "./base-specialist";

const CFG: SpecialistConfig = {
  id: "triage",
  model: (env) => env.MODEL_HAIKU,
  allow: ["list_tickets", "get_ticket", "update_ticket", "post_message"],
  system: [
    "You are the Triage specialist for an IT help desk.",
    "Classify and prioritize tickets, set status/priority, and draft concise replies.",
    "Only touch tickets in scope. Never invent ids — list/get first.",
    FINDING_FORMAT,
  ].join("\n"),
};

export class TriageAgent extends Agent<Env> {
  async run(taskSpec: string) {
    return runSpecialist(this, CFG, taskSpec, this.env);
  }
}
