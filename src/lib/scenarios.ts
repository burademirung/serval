export interface Scenario {
  prompt: string;
  specialists: ("triage" | "access-review" | "onboarding")[];
}

export const SCENARIOS: Record<string, Scenario> = {
  triage: {
    prompt: "Triage and prioritize all open IT tickets, and reply to the highest-priority one.",
    specialists: ["triage"],
  },
  access: {
    prompt: "Review all pending just-in-time access requests and record decisions per policy.",
    specialists: ["access-review"],
  },
  onboard: {
    prompt: "Onboard the new employee Jane Doe.",
    specialists: ["onboarding"],
  },
  fanout: {
    prompt: "Onboard Jane Doe and review her pending access requests.",
    specialists: ["onboarding", "access-review"],
  },
};
