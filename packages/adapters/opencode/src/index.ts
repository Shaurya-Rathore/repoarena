import {
	detectExecutable,
	type AgentAdapter,
	type AdapterResult,
} from "@repoarena/adapter-sdk";
export class OpenCodeAdapter implements AgentAdapter {
	readonly id = "opencode";
	detect = () => detectExecutable("opencode");
	async run(i: {
		cwd: string;
		prompt: string;
		model?: string;
		timeout_seconds: number;
		env: Record<string, string>;
	}): Promise<AdapterResult> {
		return {
			agent: this.id,
			version: null,
			model: i.model ?? null,
			usage: null,
			reported_cost_micros: null,
			stdout: "",
			stderr: "OpenCode execution requires the installed opencode CLI.",
			exit_code: null,
			timed_out: false,
			metadata: { command: ["opencode", "run", i.prompt] },
		};
	}
}
