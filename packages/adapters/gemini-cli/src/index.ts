import {
	detectExecutable,
	runAdapterCommand,
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
		return runAdapterCommand(
			this.id,
			"gemini",
			[
				"-p",
				i.prompt,
				"--output-format",
				"json",
				...(i.model ? ["--model", i.model] : []),
			],
			i,
		);
	}
}
