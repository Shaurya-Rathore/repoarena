import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectArtifactManifest } from "./index.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
	const root = join(tmpdir(), `repoarena-artifacts-${crypto.randomUUID()}`);
	roots.push(root);
	await mkdir(root, { recursive: true });
	return root;
}
afterEach(async () =>
	Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	),
);

it("collects stable safe file metadata", async () => {
	const root = await fixture();
	await writeFile(join(root, "result.log"), "ok");
	await writeFile(join(root, "private.json"), "{}");
	const manifest = await collectArtifactManifest(root, [
		{
			path: "private.json",
			visibility: "EVALUATOR_PRIVATE",
			source: "evaluator",
		},
		{ path: "result.log", visibility: "PUBLIC", source: "verification" },
	]);
	expect(manifest.map((entry) => entry.logical_path)).toEqual([
		"private.json",
		"result.log",
	]);
	expect(manifest[1]?.sha256).toMatch(/^[a-f0-9]{64}$/);
});

it("rejects traversal and symlink escapes", async () => {
	const root = await fixture();
	await writeFile(join(root, "safe.txt"), "safe");
	await symlink("/etc/hosts", join(root, "escape.txt"));
	await expect(
		collectArtifactManifest(root, [
			{ path: "../safe.txt", visibility: "PUBLIC", source: "agent" },
		]),
	).rejects.toThrow("Unsafe artifact path");
	await expect(
		collectArtifactManifest(root, [
			{ path: "escape.txt", visibility: "PUBLIC", source: "agent" },
		]),
	).rejects.toThrow("regular non-symlink");
});

it("enforces aggregate size limits", async () => {
	const root = await fixture();
	await writeFile(join(root, "large.log"), "12345");
	await expect(
		collectArtifactManifest(
			root,
			[{ path: "large.log", visibility: "PUBLIC", source: "agent" }],
			{ max_files: 1, max_file_bytes: 4, max_total_bytes: 4 },
		),
	).rejects.toThrow("Artifact size exceeds limit");
});
