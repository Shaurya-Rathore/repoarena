import { expect, it, vi } from "vitest";
import { CloudScheduler, CloudWorker } from "./index.js";

const runner = {
	type: "RUNNER" as const,
	runnerId: "runner",
	organizationId: "org",
};

it("executes one claimed job and persists completion", async () => {
	const cloud = {
		claimJob: vi.fn().mockResolvedValue({ id: "job", type: "BENCHMARK_RUN" }),
		submitResult: vi.fn().mockResolvedValue({ replay: false }),
		failJob: vi.fn(),
	};
	const worker = new CloudWorker(cloud as never, runner, {
		BENCHMARK_RUN: async () => ({ schema_version: 1, state: "COMPLETED" }),
	});
	expect(await worker.runOnce()).toEqual({ state: "SUCCEEDED", jobId: "job" });
	expect(cloud.submitResult).toHaveBeenCalledOnce();
});

it("dead-letters unsupported jobs and ticks schedules", async () => {
	const cloud = {
		claimJob: vi.fn().mockResolvedValue({ id: "job", type: "UNKNOWN" }),
		submitResult: vi.fn(),
		failJob: vi.fn(),
		schedulerTick: vi.fn().mockResolvedValue(2),
	};
	expect(
		await new CloudWorker(cloud as never, runner, {}).runOnce(),
	).toMatchObject({ state: "DEAD_LETTER" });
	expect(await new CloudScheduler(cloud as never).runOnce()).toBe(2);
});
