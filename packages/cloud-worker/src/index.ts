import type { CloudService, JobClaim, Principal } from "@repoarena/cloud-core";

export type JobHandler = (
	job: JobClaim,
	signal: AbortSignal,
) => Promise<unknown>;
export type WorkerOutcome =
	| { state: "IDLE" }
	| { state: "SUCCEEDED"; jobId: string }
	| { state: "RETRYING" | "DEAD_LETTER"; jobId: string; code: string };

export class CloudWorker {
	constructor(
		private readonly cloud: CloudService,
		private readonly runner: Extract<Principal, { type: "RUNNER" }>,
		private readonly handlers: Readonly<Record<string, JobHandler>>,
	) {}
	async runOnce(
		signal: AbortSignal = new AbortController().signal,
	): Promise<WorkerOutcome> {
		if (signal.aborted) return { state: "IDLE" };
		const job = await this.cloud.claimJob(this.runner);
		if (!job) return { state: "IDLE" };
		const handler = this.handlers[job.type];
		if (!handler) {
			await this.cloud.failJob(
				this.runner,
				job.id,
				"HANDLER_UNAVAILABLE",
				"No compatible job handler is installed.",
				false,
			);
			return {
				state: "DEAD_LETTER",
				jobId: job.id,
				code: "HANDLER_UNAVAILABLE",
			};
		}
		try {
			const result = await handler(job, signal);
			await this.cloud.submitResult(this.runner, job.id, result);
			return { state: "SUCCEEDED", jobId: job.id };
		} catch (error) {
			const classified = error as {
				code?: string;
				retryable?: boolean;
				message?: string;
			};
			const retryable = classified.retryable === true;
			const code = classified.code ?? "WORKER_FAILED";
			await this.cloud.failJob(
				this.runner,
				job.id,
				code,
				classified.message?.slice(0, 500) ?? "Worker execution failed.",
				retryable,
			);
			return {
				state: retryable ? "RETRYING" : "DEAD_LETTER",
				jobId: job.id,
				code,
			};
		}
	}
}

export class CloudScheduler {
	constructor(private readonly cloud: CloudService) {}
	runOnce(limit = 100) {
		return this.cloud.schedulerTick(limit);
	}
}
