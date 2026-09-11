import {
	detectExecutable,
	type AgentAdapter,
	type AdapterResult,
} from "@repoarena/adapter-sdk";
import { spawn } from "node:child_process";

export const codexExecArgs = (prompt: string, model?: string): string[] => [
	"exec",
	"--json",
	"--color",
	"never",
	"--sandbox",
	"workspace-write",
	"--ephemeral",
	...(model ? ["--model", model] : []),
	prompt,
];

export const parseCodexUsage = (stdout: string): AdapterResult["usage"] => {
	let usage: AdapterResult["usage"] = null;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				type?: string;
				usage?: Record<string, unknown>;
			};
			if (event.type !== "turn.completed" || !event.usage) continue;
			const integer = (name: string): number | undefined => {
				const value = event.usage?.[name];
				return typeof value === "number" &&
					Number.isSafeInteger(value) &&
					value >= 0
					? value
					: undefined;
			};
			const input = integer("input_tokens");
			const cached = integer("cached_input_tokens");
			const output = integer("output_tokens");
			const reasoning = integer("reasoning_output_tokens");
			if (input === undefined || output === undefined) continue;
			usage = {
				input_tokens: input,
				...(cached === undefined ? {} : { cached_input_tokens: cached }),
				output_tokens: output,
				...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }),
			};
		} catch {
			// Ignore progress text that is not a complete JSONL usage event.
		}
	}
	return usage;
};

export class CodexAdapter implements AgentAdapter {
	readonly id = "codex";
	detect = () => detectExecutable("codex");
	async run(i: {
		cwd: string;
		prompt: string;
		model?: string;
		timeout_seconds: number;
		env: Record<string, string>;
	}): Promise<AdapterResult> {
		return new Promise((resolve) => {
			const args = codexExecArgs(i.prompt, i.model);
			const p = spawn("codex", args, {
				cwd: i.cwd,
				env: { PATH: process.env.PATH ?? "", ...i.env },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let timed = false;
			p.stdout.on("data", (c) => {
				stdout += String(c);
			});
			p.stderr.on("data", (c) => {
				stderr += String(c);
			});
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
					usage: parseCodexUsage(stdout),
					reported_cost_micros: null,
					stdout,
					stderr,
					exit_code: code,
					timed_out: timed,
					metadata: { format: "jsonl" },
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
