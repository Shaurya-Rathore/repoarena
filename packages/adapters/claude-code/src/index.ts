import {
	detectExecutable,
	type AgentAdapter,
	type AdapterResult,
} from "@repoarena/adapter-sdk";
export class ClaudeCodeAdapter implements AgentAdapter {
	readonly id = "claude-code";
	detect = () => detectExecutable("claude");
	async run(i: {
		cwd: string;
		prompt: string;
		model?: string;
		timeout_seconds: number;
		env: Record<string, string>;
	}): Promise<AdapterResult> {
		const { spawn } = await import("node:child_process");
		return new Promise((resolve) => {
			const p = spawn(
				"claude",
				[
					"-p",
					"--output-format",
					"json",
					...(i.model ? ["--model", i.model] : []),
					i.prompt,
				],
				{
					cwd: i.cwd,
					env: { PATH: process.env.PATH ?? "", ...i.env },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "",
				stderr = "",
				timed = false;
			p.stdout.on("data", (c) => (stdout += String(c)));
			p.stderr.on("data", (c) => (stderr += String(c)));
			const t = setTimeout(() => {
				timed = true;
				p.kill("SIGTERM");
			}, i.timeout_seconds * 1000);
			p.on("close", (code) => {
				clearTimeout(t);
				resolve({
					agent: this.id,
					version: null,
					model: i.model ?? null,
					usage: null,
					reported_cost_micros: null,
					stdout,
					stderr,
					exit_code: code,
					timed_out: timed,
					metadata: { format: "json" },
				});
			});
			p.on("error", (e) =>
				resolve({
					agent: this.id,
					version: null,
					model: i.model ?? null,
					usage: null,
					reported_cost_micros: null,
					stdout,
					stderr: e.message,
					exit_code: null,
					timed_out: false,
					metadata: { unavailable: true },
				}),
			);
		});
	}
}
