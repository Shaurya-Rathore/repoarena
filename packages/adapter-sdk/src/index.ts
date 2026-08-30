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
