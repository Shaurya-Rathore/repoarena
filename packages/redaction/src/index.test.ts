import { expect, it } from "vitest";
import { SecretRedactor } from "./index.js";
it("redacts exact and token-like secrets", () => {
	const r = new SecretRedactor(["super-secret-token-value"]);
	expect(
		r.redact(
			"x super-secret-token-value y Bearer ghp_abcdefghijklmnopqrstuvwx",
		),
	).toBe("x [REDACTED] y [REDACTED]");
});
