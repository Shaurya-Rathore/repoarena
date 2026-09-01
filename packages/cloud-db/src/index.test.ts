import { expect, it } from "vitest";
import { assertSafeTestDatabase } from "./index.js";

it("refuses destructive operations outside the canonical local test database", () => {
	expect(() =>
		assertSafeTestDatabase("postgresql://repoarena:x@localhost/repoarena_test"),
	).not.toThrow();
	for (const value of [
		"postgresql://repoarena:x@localhost/repoarena",
		"postgresql://repoarena:x@db.example.com/repoarena_test",
		"postgresql://repoarena:x@127.0.0.1/production",
	])
		expect(() => assertSafeTestDatabase(value)).toThrow(
			/loopback repoarena_test/,
		);
});
