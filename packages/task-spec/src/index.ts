import { contentHash } from "@repoarena/core";
import { z } from "zod";

const command = z.object({
	command: z.string().min(1),
	timeout_seconds: z.number().int().positive().max(3600).default(300),
});
export const taskSchema = z
	.object({
		schema: z.literal("repoarena.task/v1"),
		id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
		title: z.string().min(1).max(240),
		prompt: z.string().min(1).max(50_000),
		base_commit: z.string().regex(/^[0-9a-f]{7,64}$/i),
		verification: z.object({
			required: z.array(command).min(1),
			optional: z.array(command).default([]),
		}),
		constraints: z
			.object({
				forbidden_paths: z.array(z.string()).default([]),
				max_patch_bytes: z.number().int().positive().default(1_000_000),
				network: z.enum(["none", "allowlist", "full"]).default("none"),
			})
			.default({}),
		tags: z.array(z.string().min(1)).default([]),
	})
	.strict();
export type Task = z.infer<typeof taskSchema>;
export const taskContentHash = (task: Task): string => contentHash(task);
