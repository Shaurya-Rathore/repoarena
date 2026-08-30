import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RepoArenaError } from "@repoarena/core";
import { parse } from "yaml";
import { z } from "zod";

export const configSchema = z
	.object({
		schema: z.literal("repoarena.config/v1"),
		benchmark: z
			.object({
				name: z.string().min(1),
				tasks_dir: z.string().default(".repoarena/tasks"),
			})
			.default({ name: "default" }),
		runner: z
			.object({
				backend: z.enum(["local", "docker"]).default("local"),
				timeout_seconds: z.number().int().positive().default(900),
				network: z.enum(["none", "allowlist", "full"]).default("none"),
			})
			.default({}),
	})
	.strict();
export type RepoArenaConfig = z.infer<typeof configSchema>;
export async function loadConfig(root: string): Promise<RepoArenaConfig> {
	try {
		return configSchema.parse(
			parse(await readFile(join(root, ".repoarena", "config.yaml"), "utf8")),
		);
	} catch (error) {
		if (error instanceof z.ZodError)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Invalid .repoarena/config.yaml",
				{ issues: error.issues },
			);
		throw error;
	}
}
