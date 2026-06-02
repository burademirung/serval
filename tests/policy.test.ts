import { describe, it, expect } from "vitest";
import { decideAccess } from "../src/policy/access-policy";
import type { AccessRequestContext } from "../src/policy/access-policy";

const base: AccessRequestContext = {
  resource: "github", scope: "read",
  requesterActive: true, isProduction: false, isAdmin: false,
};

describe("decideAccess", () => {
  it("denies inactive requesters", () => {
    expect(decideAccess({ ...base, requesterActive: false }).decision).toBe("deny");
  });
  it("escalates admin grants", () => {
    expect(decideAccess({ ...base, isAdmin: true }).decision).toBe("escalate");
  });
  it("escalates production access", () => {
    expect(decideAccess({ ...base, isProduction: true, scope: "write" }).decision).toBe("escalate");
  });
  it("approves low-risk reads for active users", () => {
    expect(decideAccess(base).decision).toBe("approve");
  });
  it("always returns a non-empty reason", () => {
    for (const ctx of [base, { ...base, isAdmin: true }, { ...base, requesterActive: false }]) {
      expect(decideAccess(ctx).reason.length).toBeGreaterThan(0);
    }
  });
});
