import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileObjectStorage, objectKey, validateObjectKey } from "./index.js";

const roots: string[] = [];
afterEach(async () =>
	Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	),
);
it("implements the object contract with generated tenant keys", async () => {
	const root = await mkdtemp(join(tmpdir(), "repoarena-objects-"));
	roots.push(root);
	const store = new FileObjectStorage(root, () => 1_000);
	const key = objectKey(randomUUID());
	const body = Buffer.from("artifact");
	const checksum = createHash("sha256").update(body).digest("base64");
	expect(
		await store.put(key, body, { contentType: "text/plain", checksum }),
	).toMatchObject({ key, size: 8 });
	expect(Buffer.from(await store.get(key)).toString()).toBe("artifact");
	expect(await store.head(key)).toMatchObject({ checksum });
	expect(await store.signedReadUrl(key, 60)).toContain("expires=61000");
	await store.delete(key);
	expect(await store.head(key)).toBeNull();
});
it("rejects user-controlled and traversal-like object keys", () => {
	for (const key of [
		"../secret",
		"/absolute",
		"org/victim/file",
		`org/${randomUUID()}/objects/../escape`,
	])
		expect(() => validateObjectKey(key)).toThrow("server-generated");
});
