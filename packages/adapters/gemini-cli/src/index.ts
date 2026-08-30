import {
	detectExecutable,
	type AgentAdapter,
	type AdapterResult,
} from "@repoarena/adapter-sdk";
export class GeminiCliAdapter implements AgentAdapter {
	readonly id = "gemini-cli";
	detect = () => detectExecutable("gemini");
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
			stderr: "Gemini execution requires the installed gemini CLI.",
			exit_code: null,
			timed_out: false,
			metadata: {
				command: ["gemini", "-p", i.prompt, "--output-format", "json"],
			},
		};
	}
}
