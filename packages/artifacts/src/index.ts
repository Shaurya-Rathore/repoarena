import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { RepoArenaError } from "@repoarena/core";

export type ArtifactVisibility = "PUBLIC" | "PRIVATE" | "EVALUATOR_PRIVATE";
export type ArtifactRequest = Readonly<{
	path: string;
	visibility: ArtifactVisibility;
	source: "agent" | "verification" | "evaluator" | "runner";
}>;
export type ArtifactManifestEntry = Readonly<{
	logical_path: string;
	sha256: string;
	size_bytes: number;
	media_type: string;
	visibility: ArtifactVisibility;
	source: ArtifactRequest["source"];
}>;
export type ArtifactCollectionLimits = Readonly<{
	max_files: number;
	max_file_bytes: number;
	max_total_bytes: number;
}>;
export const DEFAULT_ARTIFACT_LIMITS: ArtifactCollectionLimits = {
	max_files: 32,
	max_file_bytes: 5_000_000,
	max_total_bytes: 20_000_000,
};

function isWithin(root: string, child: string): boolean {
	const part = relative(root, child);
	return (
		part !== "" &&
		!part.startsWith(`..${"/"}`) &&
		part !== ".." &&
		!isAbsolute(part)
	);
}

function mediaType(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".json")) return "application/json";
	if (lower.endsWith(".xml")) return "application/xml";
	if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
	if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
	if (lower.endsWith(".patch") || lower.endsWith(".diff")) return "text/x-diff";
	return "application/octet-stream";
}

function assertRequestPath(path: string): void {
	if (
		!path ||
		isAbsolute(path) ||
		path.includes("\0") ||
		path.split(/[\\/]/).includes("..")
	) {
		throw new RepoArenaError("EVALUATION_FAILED", "Unsafe artifact path.");
	}
}

/**
 * Hashes declared regular files without copying them. The caller chooses where
 * bytes are stored; this boundary exists to ensure agent paths never escape a
 * trusted attempt workspace.
 */
export async function collectArtifactManifest(
	workspaceRoot: string,
	requests: readonly ArtifactRequest[],
	limits: ArtifactCollectionLimits = DEFAULT_ARTIFACT_LIMITS,
	redactText?: (value: string) => string,
): Promise<readonly ArtifactManifestEntry[]> {
	if (requests.length > limits.max_files) {
		throw new RepoArenaError(
			"EVALUATION_FAILED",
			"Artifact file count exceeds limit.",
		);
	}
	const root = await realpath(workspaceRoot);
	let total = 0;
	const result: ArtifactManifestEntry[] = [];
	for (const request of [...requests].sort((a, b) =>
		a.path.localeCompare(b.path),
	)) {
		assertRequestPath(request.path);
		const requested = resolve(root, request.path);
		if (!isWithin(root, requested)) {
			throw new RepoArenaError(
				"EVALUATION_FAILED",
				"Artifact path escapes workspace.",
			);
		}
		const linkInfo = await lstat(requested);
		if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
			throw new RepoArenaError(
				"EVALUATION_FAILED",
				"Artifact must be a regular non-symlink file.",
			);
		}
		const resolved = await realpath(requested);
		if (!isWithin(root, resolved)) {
			throw new RepoArenaError(
				"EVALUATION_FAILED",
				"Artifact symlink escapes workspace.",
			);
		}
		const info = await stat(resolved);
		if (
			info.size > limits.max_file_bytes ||
			total + info.size > limits.max_total_bytes
		) {
			throw new RepoArenaError(
				"EVALUATION_FAILED",
				"Artifact size exceeds limit.",
			);
		}
		const digest = createHash("sha256");
		const bytes = await (await import("node:fs/promises")).readFile(resolved);
		const type = mediaType(basename(request.path));
		const publicBytes =
			redactText &&
			(type.startsWith("text/") ||
				type === "application/json" ||
				type === "application/xml")
				? Buffer.from(redactText(bytes.toString("utf8")))
				: bytes;
		digest.update(publicBytes);
		total += info.size;
		result.push({
			logical_path: request.path,
			sha256: digest.digest("hex"),
			size_bytes: publicBytes.byteLength,
			media_type: type,
			visibility: request.visibility,
			source: request.source,
		});
	}
	return result;
}
