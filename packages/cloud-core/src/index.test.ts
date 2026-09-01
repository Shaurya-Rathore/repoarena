import { expect, it } from "vitest";
import { roleAllows } from "./index.js";

it("centralizes the role permission lattice", () => {
	expect(roleAllows("OWNER", "BILLING_MANAGE")).toBe(true);
	expect(roleAllows("ADMIN", "BILLING_MANAGE")).toBe(false);
	expect(roleAllows("MEMBER", "BENCHMARK_RUN")).toBe(true);
	expect(roleAllows("VIEWER", "BENCHMARK_RUN")).toBe(false);
});
