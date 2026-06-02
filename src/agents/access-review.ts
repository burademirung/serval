import { Agent } from "agents";
import { runSpecialist, FINDING_FORMAT } from "./base-specialist";
import type { SpecialistConfig } from "./base-specialist";
import { decideAccess } from "../policy/access-policy";

const CFG: SpecialistConfig = {
  id: "access-review",
  model: (env) => env.MODEL_SONNET,
  allow: ["list_access_requests", "get_access_request", "get_user", "review_access_request"],
  system: [
    "You are the Access-Review specialist.",
    "For each pending request in scope: get the request and requester, then decide and record it.",
    "You MUST follow the deterministic policy: deny if requester inactive; escalate admin or production grants; approve low-risk reads for active users. Never approve admin/production yourself.",
    FINDING_FORMAT,
  ].join("\n"),
};

export class AccessReviewAgent extends Agent<Env> {
  async run(taskSpec: string) {
    void decideAccess; // deterministic policy is the source of truth; agent mirrors it
    return runSpecialist(this, CFG, taskSpec, this.env);
  }
}
