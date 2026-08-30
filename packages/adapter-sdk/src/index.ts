import type { Usage } from "@repoarena/pricing";
export type Detection = {
	available: boolean;
	version: string | null;
	auth: "unknown" | "available" | "unavailable";
	diagnostic?: string;
};
export type AdapterResult = {
	agent: string;
	version: string | null;
	model: string | null;
	usage: Usage | null;
	reported_cost_micros: number | null;
	stdout: string;
	stderr: string;
	exit_code: number | null;
	timed_out: boolean;
	metadata: Record<string, unknown>;
};
export interface AgentAdapter {
	readonly id: string;
	detect(): Promise<Detection>;
	run(input: {
		cwd: string;
		prompt: string;
		model?: string;
		timeout_seconds: number;
		env: Record<string, string>;
	}): Promise<AdapterResult>;
}
export async function detectExecutable(name: string): Promise<Detection> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		const p = spawn(name, ["--version"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let out = "";
		p.stdout.on("data", (c) => (out += String(c)));
		p.on("error", () =>
			resolve({
				available: false,
				version: null,
				auth: "unknown",
				diagnostic: `${name} unavailable`,
			}),
		);
		p.on("close", (code) =>
			resolve(
				code === 0
					? { available: true, version: out.trim() || null, auth: "unknown" }
					: {
							available: false,
							version: null,
							auth: "unknown",
							diagnostic: `${name} --version failed`,
						},
			),
		);
	});
}

export async function runAdapterCommand(
	agent: string,
	executable: string,
	args: string[],
	input: {
		cwd: string;
		model?: string;
		timeout_seconds: number;
		env: Record<string, string>;
	},
): Promise<AdapterResult> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		const child = spawn(executable, args, {
			cwd: input.cwd,
			env: { PATH: process.env.PATH ?? "", ...input.env },
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const bounded = (value: string) =>
			value.length > 100_000
				? `${value.slice(0, 100_000)}\n[output truncated]`
				: value;
		child.stdout.on("data", (chunk) => {
			stdout = bounded(stdout + String(chunk));
		});
		child.stderr.on("data", (chunk) => {
			stderr = bounded(stderr + String(chunk));
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
		}, input.timeout_seconds * 1_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({
				agent,
				version: null,
				model: input.model ?? null,
				usage: null,
				reported_cost_micros: null,
				stdout,
				stderr: bounded(`${stderr}${error.message}`),
				exit_code: null,
				timed_out: false,
				metadata: { unavailable: true },
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				agent,
				version: null,
				model: input.model ?? null,
				usage: null,
				reported_cost_micros: null,
				stdout,
				stderr,
				exit_code: code,
				timed_out: timedOut,
				metadata: { argv: [executable, ...args] },
			});
		});
	});
}
