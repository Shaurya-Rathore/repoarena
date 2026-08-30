import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "./index.js";

describe("canonical hashing", () => {
	it("sorts keys independently of insertion order", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(contentHash({ b: 1, a: 2 })).toBe(contentHash({ a: 2, b: 1 }));
	});
});
