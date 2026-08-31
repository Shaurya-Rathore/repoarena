import type { PersistedAttempt, PersistedRun } from "@repoarena/run-store";
const escapeHtml = (value: unknown): string =>
	String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
const escapeXml = escapeHtml;
const pct = (value: number | null): string =>
	value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const dollars = (micros: number | null): string =>
	micros === null ? "unavailable" : `$${(micros / 1_000_000).toFixed(6)}`;
const solved = (attempt: PersistedAttempt): boolean =>
	attempt.evaluation.outcome === "SOLVED";
export function toTerminal(run: PersistedRun): string {
	const agents = [
		...new Set(
			run.attempts.map(
				(a) => `${a.agent.id}${a.agent.model ? `/${a.agent.model}` : ""}`,
			),
		),
	].sort();
	const failures =
		Object.entries(run.statistics.failures)
			.map(([code, count]) => `${code}=${count}`)
			.join(", ") || "none";
	return [
		`RepoArena ${run.id} (${run.repository.commit.slice(0, 12)})`,
		`Tasks: ${new Set(run.attempts.map((a) => a.task_id)).size}  Attempts: ${run.statistics.attempt_count}  Solved: ${run.statistics.solved_count}`,
		`Agents: ${agents.join(", ") || "none"}`,
		`Success: ${pct(run.statistics.success_rate)}  pass@1: ${pct(run.statistics.pass_at_1)}  pass@k: ${pct(run.statistics.pass_at_k)}`,
		`Median duration: ${run.statistics.median_duration_ms ?? "n/a"}ms  Cost: ${dollars(run.statistics.total_cost_micros)}`,
		`Failures: ${failures}`,
	].join("\n");
}
export function toJson(run: PersistedRun): string {
	return `${JSON.stringify(run, null, 2)}\n`;
}
function attemptHtml(a: PersistedAttempt): string {
	const checks = a.public_verification
		.map(
			(c) =>
				`<li>${escapeHtml(c.id)}: ${c.passed ? "passed" : "failed"} (${c.duration_ms}ms)<pre>${escapeHtml(`${c.stdout}\n${c.stderr}`)}</pre></li>`,
		)
		.join("");
	const integrity =
		a.integrity
			.map((i) => `<li>${escapeHtml(i.code)}: ${escapeHtml(i.message)}</li>`)
			.join("") || "<li>none</li>";
	const regressions =
		a.regressions
			.map((i) => `<li>${escapeHtml(i.code)}: ${escapeHtml(i.message)}</li>`)
			.join("") || "<li>none</li>";
	const files =
		(a.patch.files ?? [])
			.map(
				(file) =>
					`<li>${escapeHtml(file.status)}: ${escapeHtml(file.previous_path ? `${file.previous_path} → ${file.path}` : file.path)}</li>`,
			)
			.join("") || "<li>none</li>";
	return `<article><h3>${escapeHtml(a.task_id)} · ${escapeHtml(a.agent.id)}</h3><p>Outcome: <strong>${escapeHtml(a.evaluation.outcome)}</strong> ${escapeHtml(a.evaluation.reason ?? "")}</p><p>Hidden: ${a.private_verification.passed} passed, ${a.private_verification.failed} failed</p><p>Patch: ${a.patch.files_changed} files, +${a.patch.lines_added}/-${a.patch.lines_removed}</p><h4>Changed files</h4><ul>${files}</ul><p>Usage: ${escapeHtml(a.usage.status)} · Cost: ${escapeHtml(dollars(a.cost.micros))}</p><h4>Public verification</h4><ul>${checks}</ul><h4>Integrity</h4><ul>${integrity}</ul><h4>Regressions</h4><ul>${regressions}</ul></article>`;
}
export function toHtml(run: PersistedRun): string {
	const rows = run.attempts
		.map(
			(a) =>
				`<tr><td>${escapeHtml(a.task_id)}</td><td>${escapeHtml(a.agent.id)}</td><td>${escapeHtml(a.agent.model ?? "default")}</td><td>${escapeHtml(a.evaluation.outcome)}</td><td>${a.duration_ms}ms</td><td>${escapeHtml(dollars(a.cost.micros))}</td></tr>`,
		)
		.join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RepoArena ${escapeHtml(run.id)}</title><style>body{font:15px system-ui;max-width:1100px;margin:auto;padding:2rem;color:#18202a}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd5df;padding:.5rem;text-align:left}pre{white-space:pre-wrap;overflow:auto;background:#f4f6f8;padding:.75rem}article{border-top:2px solid #25364d;margin-top:2rem}</style></head><body><main><h1>RepoArena benchmark ${escapeHtml(run.id)}</h1><section><h2>Summary</h2><pre>${escapeHtml(toTerminal(run))}</pre></section><section><h2>Agent comparison</h2><table><thead><tr><th>Task</th><th>Agent</th><th>Model</th><th>Outcome</th><th>Duration</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table></section><section><h2>Attempts</h2>${run.attempts.map(attemptHtml).join("")}</section></main></body></html>`;
}
export function toJunit(run: PersistedRun): string {
	const failures = run.attempts.filter(
		(a) => a.evaluation.outcome === "UNSOLVED",
	).length;
	const errors = run.attempts.filter(
		(a) => a.evaluation.outcome === "INFRASTRUCTURE_FAILURE",
	).length;
	const cases = run.attempts
		.map((a) => {
			const name = escapeXml(`${a.task_id} [${a.agent.id}] #${a.index}`);
			if (solved(a))
				return `<testcase name="${name}" time="${a.duration_ms / 1000}"/>`;
			const message = escapeXml(
				a.failure?.message ?? a.evaluation.reason ?? "unsolved",
			);
			return a.evaluation.outcome === "INFRASTRUCTURE_FAILURE"
				? `<testcase name="${name}" time="${a.duration_ms / 1000}"><error message="${message}"/></testcase>`
				: `<testcase name="${name}" time="${a.duration_ms / 1000}"><failure message="${message}"/></testcase>`;
		})
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="RepoArena ${escapeXml(run.id)}" tests="${run.attempts.length}" failures="${failures}" errors="${errors}"><properties><property name="solved_count" value="${run.statistics.solved_count}"/><property name="total_cost_micros" value="${run.statistics.total_cost_micros ?? "unavailable"}"/></properties>${cases}</testsuite>\n`;
}
