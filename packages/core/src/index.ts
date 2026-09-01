import { createHash } from "node:crypto";

export type ErrorCode =
	| "CONFIG_INVALID"
	| "TASK_INVALID"
	| "REPOSITORY_NOT_FOUND"
	| "AGENT_UNAVAILABLE"
	| "AUTH_UNAVAILABLE"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "CONFLICT"
	| "RATE_LIMITED"
	| "INFRASTRUCTURE_FAILED"
	| "ATTEMPT_FAILED"
	| "EVALUATION_FAILED"
	| "CANCELLED";

export class RepoArenaError extends Error {
	public readonly code: ErrorCode;
	public readonly details?: Record<string, unknown> | undefined;
	public constructor(
		code: ErrorCode,
		message: string,
		details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "RepoArenaError";
		this.code = code;
		this.details = details;
	}
}

function normalize(value: unknown): unknown {
	if (typeof value === "string") return value.normalize("NFC");
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k.normalize("NFC"), normalize(v)]),
		);
	}
	return value;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalize(value));
}

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function contentHash(value: unknown): string {
	return sha256(canonicalJson(value));
}
