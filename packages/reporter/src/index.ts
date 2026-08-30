import type { AttemptResult } from "@repoarena/runner-core";
const escapeHtml = (text: string) =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
export function toHtml(result: AttemptResult): string {
	const checks = result.verification
		.map(
			(check) =>
				`<li><code>${escapeHtml(check.command)}</code>: ${check.exit_code === 0 ? "passed" : "failed"} (${check.duration_ms}ms)<pre>${escapeHtml(`${check.stdout}\n${check.stderr}`)}</pre></li>`,
		)
		.join("");
	return `<!doctype html><html lang="en"><meta charset="utf-8"><title>RepoArena ${escapeHtml(result.id)}</title><body><main><h1>RepoArena attempt ${escapeHtml(result.id)}</h1><p>Status: <strong>${result.status}</strong></p><p>Task: ${escapeHtml(result.task_id)} · Patch: ${result.patch_bytes} bytes</p><h2>Verification</h2><ul>${checks}</ul><h2>Patch</h2><pre>${escapeHtml(result.patch)}</pre></main></body></html>`;
}
