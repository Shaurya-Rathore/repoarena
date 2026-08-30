import {
	detectExecutable,
	runAdapterCommand,
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
		return runAdapterCommand(
			this.id,
			"opencode",
			["run", i.prompt, ...(i.model ? ["--model", i.model] : [])],
			i,
		);
	}
}
