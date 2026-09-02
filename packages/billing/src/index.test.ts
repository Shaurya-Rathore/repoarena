import { expect, it } from "vitest";
import { canonicalBillingStatus, entitledPlan } from "./index.js";

it("centralizes provider state and past-due grace policy", () => {
	expect(canonicalBillingStatus("canceled")).toBe("CANCELLED");
	expect(entitledPlan("PRO", "ACTIVE")).toBe("PRO");
	expect(entitledPlan("TEAM", "TRIALING")).toBe("TEAM");
	expect(entitledPlan("PRO", "PAST_DUE")).toBe("PRO");
	expect(entitledPlan("TEAM", "UNPAID")).toBe("COMMUNITY");
	expect(entitledPlan("TEAM", "CANCELLED")).toBe("COMMUNITY");
});
