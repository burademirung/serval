import { describe, it, expect } from "vitest";
import { SCENARIOS } from "../../src/lib/scenarios";

// Structural evals (cheap, no API key) — always run: guard the routing contract.
describe("scenario routing map", () => {
  it("triage scenario routes only to triage", () => {
    expect(SCENARIOS.triage!.specialists).toEqual(["triage"]);
  });
  it("fanout routes to onboarding + access-review", () => {
    expect(SCENARIOS.fanout!.specialists).toEqual(
      expect.arrayContaining(["onboarding", "access-review"]),
    );
  });
});

// End-state evals (need ANTHROPIC_API_KEY + a running orchestrator) — gated.
const RUN = process.env.RUN_EVALS ? describe : describe.skip;
RUN("end-state evals (RUN_EVALS)", () => {
  it("placeholder for live end-state checks", () => {
    // Wire to a deployed/dev /api/run + an LLM-judge rubric on the final Serval state.
    expect(true).toBe(true);
  });
});
