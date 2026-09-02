import { expect, it } from "vitest";
import {
	type TriggerPolicy,
	checkConclusion,
	evaluateTrigger,
} from "./index.js";

const policy: TriggerPolicy = {
	pushDefaultBranch: true,
	pullRequests: true,
	includeDrafts: false,
	forkPolicy: "SKIP",
	branches: ["main", "release/*"],
	paths: ["src/**"],
	budget: {
		max_attempts: 3,
		max_cost_micros: 100_000,
		max_runtime_ms: 600_000,
	},
};

it("evaluates deterministic push, path, draft and fork trigger policy", () => {
	expect(
		evaluateTrigger({
			event: "push",
			policy,
			ref: "refs/heads/main",
			defaultBranch: "main",
			changedPaths: ["src/a.ts"],
			changedPathsComplete: true,
		}),
	).toMatchObject({ run: true, privileged: true });
	expect(
		evaluateTrigger({
			event: "push",
			policy,
			ref: "refs/heads/dev",
			defaultBranch: "main",
		}),
	).toMatchObject({ run: false, reason: "NON_DEFAULT_BRANCH" });
	expect(
		evaluateTrigger({
			event: "push",
			policy,
			ref: "refs/heads/main",
			defaultBranch: "main",
			changedPaths: ["docs/a.md"],
			changedPathsComplete: true,
		}),
	).toMatchObject({ run: false, reason: "PATH_FILTERED" });
	expect(
		evaluateTrigger({
			event: "push",
			policy,
			ref: "refs/heads/main",
			defaultBranch: "main",
			changedPathsComplete: false,
		}),
	).toMatchObject({ run: true, reason: "PATH_EVIDENCE_INCOMPLETE_RUN_SAFELY" });
	expect(
		evaluateTrigger({
			event: "pull_request",
			policy,
			ref: "refs/heads/main",
			defaultBranch: "main",
			draft: true,
		}),
	).toMatchObject({ run: false, reason: "DRAFT" });
	expect(
		evaluateTrigger({
			event: "pull_request",
			policy,
			ref: "refs/heads/main",
			defaultBranch: "main",
			fork: true,
		}),
	).toMatchObject({ run: false, reason: "FORK_RESTRICTED", privileged: false });
});

it("maps canonical public results to GitHub conclusions", () => {
	expect(
		checkConclusion({
			state: "COMPLETED",
			statistics: { solved_count: 2, attempt_count: 2, task_count: 1 },
		}),
	).toBe("success");
	expect(
		checkConclusion({
			state: "COMPLETED",
			statistics: { solved: 2, task_count: 2 },
		}),
	).toBe("success");
	expect(
		checkConclusion({
			state: "COMPLETED",
			statistics: { solved: 1, task_count: 2 },
		}),
	).toBe("failure");
	expect(checkConclusion({ state: "INFRASTRUCTURE_FAILURE" })).toBe("neutral");
	expect(checkConclusion({ state: "CANCELLED" })).toBe("cancelled");
	expect(checkConclusion({ state: "TIMED_OUT" })).toBe("timed_out");
});
