import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { contentHash, RepoArenaError } from "@repoarena/core";
import {
	collectArtifactManifest,
	type ArtifactManifestEntry,
	type ArtifactRequest,
} from "@repoarena/artifacts";
import {
	evaluate,
	verification,
	type PublicEvaluationResult,
} from "@repoarena/evaluator";
import { GitRepository, type ChangedFile } from "@repoarena/git";
import { analyzeIntegrity, type IntegrityPolicy } from "@repoarena/integrity";
import type { EvaluatorPrivateTaskData, Task } from "@repoarena/task-spec";
import { SecretRedactor } from "@repoarena/redaction";
import type { SandboxProvider } from "@repoarena/sandbox-local";
import type { Usage } from "@repoarena/pricing";

export type AttemptState =
	| "QUEUED"
	| "PREPARING"
	| "SETUP"
	| "AGENT_RUNNING"
	| "VERIFYING"
	| "VERIFYING_PRIVATE"
	| "COLLECTING"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TIMED_OUT";
const transitions: Record<AttemptState, readonly AttemptState[]> = {
	QUEUED: ["PREPARING", "CANCELLED"],
	PREPARING: ["SETUP", "FAILED", "TIMED_OUT", "CANCELLED"],
	SETUP: ["AGENT_RUNNING", "FAILED", "TIMED_OUT", "CANCELLED"],
	AGENT_RUNNING: ["VERIFYING", "FAILED", "TIMED_OUT", "CANCELLED"],
	VERIFYING: ["COLLECTING", "FAILED", "TIMED_OUT", "CANCELLED"],
	COLLECTING: ["VERIFYING_PRIVATE", "COMPLETED", "FAILED"],
	VERIFYING_PRIVATE: [
		"COLLECTING",
		"COMPLETED",
		"FAILED",
		"TIMED_OUT",
		"CANCELLED",
	],
	COMPLETED: [],
	FAILED: [],
	CANCELLED: [],
	TIMED_OUT: [],
};
export function transitionAttempt(
	current: AttemptState,
	next: AttemptState,
): AttemptState {
	if (!transitions[current].includes(next))
		throw new RepoArenaError(
			"ATTEMPT_FAILED",
			`Invalid attempt transition ${current} -> ${next}.`,
		);
	return next;
}

export type CommandEvidence = {
	command: string;
	exit_code: number | null;
	duration_ms: number;
	stdout: string;
	stderr: string;
	timed_out: boolean;
	cancelled?: boolean;
	usage?: Usage | null;
};

function terminateProcessTree(
	child: ChildProcess,
	signal: NodeJS.Signals,
): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		// The process tree may already have exited. Termination is idempotent.
	}
}

export async function runArgv(
	argv: string[],
	cwd: string,
	timeoutSeconds: number,
	signal?: AbortSignal,
): Promise<CommandEvidence> {
	if (!argv.length)
		throw new RepoArenaError("ATTEMPT_FAILED", "Command argv is required.");
	const started = performance.now();
	return new Promise((finish) => {
		const child = spawn(argv[0] ?? "", argv.slice(1), {
			cwd,
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH ?? "", REPOARENA_NETWORK_POLICY: "none" },
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let cancelled = signal?.aborted ?? false;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = limitOutput(stdout + chunk.toString());
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = limitOutput(stderr + chunk.toString());
		});
		const forceTermination = () => terminateProcessTree(child, "SIGKILL");
		const terminate = () => {
			terminateProcessTree(child, "SIGTERM");
			setTimeout(forceTermination, 250).unref();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutSeconds * 1000);
		const onAbort = () => {
			cancelled = true;
			terminate();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (cancelled) terminate();
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			// A command may detach children before its main process exits.
			forceTermination();
			finish({
				command: JSON.stringify(argv),
				exit_code: code,
				duration_ms: Math.round(performance.now() - started),
				stdout,
				stderr,
				timed_out: timedOut,
				cancelled,
			});
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			forceTermination();
			finish({
				command: JSON.stringify(argv),
				exit_code: null,
				duration_ms: Math.round(performance.now() - started),
				stdout,
				stderr: limitOutput(`${stderr}${error.message}`),
				timed_out: timedOut,
				cancelled,
			});
		});
	});
}

export interface AttemptPhaseCoordinator {
	enterAgent(): Promise<() => void>;
	enterPrivate(): Promise<() => void>;
}

/**
 * Allows concurrent agent phases but never lets an agent phase overlap any
 * evaluator-private phase. This protects hidden assets across sibling attempts.
 */
export class LocalAttemptPhaseCoordinator implements AttemptPhaseCoordinator {
	private activeAgents = 0;
	privateActive = false;
	private readonly waitingAgents: Array<(release: () => void) => void> = [];
	private readonly waitingPrivate: Array<(release: () => void) => void> = [];

	async enterAgent(): Promise<() => void> {
		if (!this.privateActive && this.waitingPrivate.length === 0) {
			this.activeAgents++;
			return this.agentRelease();
		}
		return new Promise((resolve) => this.waitingAgents.push(resolve));
	}

	async enterPrivate(): Promise<() => void> {
		if (!this.privateActive && this.activeAgents === 0) {
			this.privateActive = true;
			return this.privateRelease();
		}
		return new Promise((resolve) => this.waitingPrivate.push(resolve));
	}

	private agentRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeAgents--;
			this.drain();
		};
	}

	private privateRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.privateActive = false;
			this.drain();
		};
	}

	private drain(): void {
		if (this.privateActive || this.activeAgents > 0) return;
		const nextPrivate = this.waitingPrivate.shift();
		if (nextPrivate) {
			this.privateActive = true;
			nextPrivate(this.privateRelease());
			return;
		}
		for (const nextAgent of this.waitingAgents.splice(0)) {
			this.activeAgents++;
			nextAgent(this.agentRelease());
		}
	}
}
export type AttemptResult = {
	id: string;
	task_id: string;
	status: "passed" | "failed" | "error";
	started_at: string;
	ended_at: string;
	patch: string;
	patch_bytes: number;
	verification: CommandEvidence[];
	provenance: { task_hash: string; workspace: string; network_policy: string };
};

const limitOutput = (text: string): string =>
	text.length > 100_000
		? `${text.slice(0, 100_000)}\n[output truncated]`
		: text;
const isTransientStoreFile = (entry: string): boolean =>
	basename(entry).startsWith(".") && basename(entry).endsWith(".tmp");
export async function runShell(
	command: string,
	cwd: string,
	timeoutSeconds: number,
): Promise<CommandEvidence> {
	const started = performance.now();
	return new Promise((finish) => {
		const child = spawn(command, {
			cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, REPOARENA_NETWORK_POLICY: "none" },
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutSeconds * 1_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			finish({
				command,
				exit_code: code,
				duration_ms: Math.round(performance.now() - started),
				stdout: limitOutput(stdout),
				stderr: limitOutput(stderr),
				timed_out: timedOut,
			});
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			finish({
				command,
				exit_code: null,
				duration_ms: Math.round(performance.now() - started),
				stdout: limitOutput(stdout),
				stderr: `${stderr}${error.message}`,
				timed_out: timedOut,
			});
		});
	});
}
async function git(root: string, args: string[]): Promise<string> {
	const result = await runArgv(["git", ...args], root, 60);
	if (result.exit_code !== 0)
		throw new RepoArenaError(
			"REPOSITORY_NOT_FOUND",
			result.stderr || "Git command failed",
		);
	return result.stdout;
}
export async function runTask(options: {
	root: string;
	task: Task;
	agentCommand?: string;
	retainWorkspace?: boolean;
}): Promise<AttemptResult> {
	const startedAt = new Date().toISOString();
	const source = resolve(options.root);
	const workspace = await mkdtemp(join(tmpdir(), "repoarena-attempt-"));
	try {
		await cp(source, workspace, {
			recursive: true,
			filter: (entry) =>
				!isTransientStoreFile(entry) &&
				!relative(source, entry).startsWith(".repoarena/state") &&
				!relative(source, entry).startsWith("node_modules"),
		});
		if (options.agentCommand) {
			await writeFile(
				join(workspace, ".repoarena-agent-prompt.txt"),
				options.task.prompt,
				{ mode: 0o600 },
			);
			const agent = await runShell(
				options.agentCommand,
				workspace,
				options.task.verification.required[0]?.timeout_seconds ?? 900,
			);
			if (agent.exit_code !== 0)
				throw new RepoArenaError("ATTEMPT_FAILED", "Agent command failed", {
					stderr: agent.stderr,
				});
		}
		const evidence: CommandEvidence[] = [];
		for (const check of options.task.verification.required) {
			const item = Array.isArray(check.command)
				? await runArgv(check.command, workspace, check.timeout_seconds)
				: await runShell(
						check.command.command,
						workspace,
						check.timeout_seconds,
					);
			evidence.push(item);
			if (item.exit_code !== 0 || item.timed_out) break;
		}
		const patch = await git(workspace, ["diff", "--binary", "--no-ext-diff"]);
		const patchBytes = Buffer.byteLength(patch);
		if (patchBytes > options.task.constraints.max_patch_bytes)
			throw new RepoArenaError(
				"EVALUATION_FAILED",
				"Patch exceeds task size limit",
				{ patchBytes },
			);
		const result: AttemptResult = {
			id: contentHash({ task: options.task.id, startedAt, patch }).slice(0, 24),
			task_id: options.task.id,
			status: evidence.every((item) => item.exit_code === 0 && !item.timed_out)
				? "passed"
				: "failed",
			started_at: startedAt,
			ended_at: new Date().toISOString(),
			patch,
			patch_bytes: patchBytes,
			verification: evidence,
			provenance: {
				task_hash: contentHash(options.task),
				workspace,
				network_policy: options.task.execution.network.mode,
			},
		};
		return result;
	} finally {
		if (!options.retainWorkspace)
			await rm(workspace, { recursive: true, force: true });
	}
}

export type IsolatedAttemptResult = Readonly<{
	schema: "repoarena.attempt/v1";
	id: string;
	state_history: readonly { state: AttemptState; at: string }[];
	patch: string;
	changed_files: readonly ChangedFile[];
	public_verification: readonly CommandEvidence[];
	private_verification: { passed: number; failed: number };
	evaluation: PublicEvaluationResult;
	artifacts: readonly ArtifactManifestEntry[];
	agent_execution?: CommandEvidence;
	agent_usage?: Readonly<Record<string, unknown>>;
}>;
export type { SandboxProvider } from "@repoarena/sandbox-local";

/**
 * Connected local attempt lifecycle. Private data enters only a second copy
 * after the agent's argv process has closed and the public patch is captured.
 */
export async function runIsolatedAttempt(options: {
	root: string;
	task: Task;
	agentArgv?: readonly string[];
	agentExecutor?: (workspace: string) => Promise<CommandEvidence>;
	privateData: EvaluatorPrivateTaskData;
	privateVerifier?: (
		workspace: string,
		data: EvaluatorPrivateTaskData,
	) => Promise<readonly string[][]>;
	integrityPolicy?: IntegrityPolicy;
	artifactRequests?: readonly ArtifactRequest[];
	secrets?: readonly string[];
	sandbox?: SandboxProvider;
	sandboxFactory?: (workspace: string) => SandboxProvider;
	signal?: AbortSignal;
	phaseCoordinator?: AttemptPhaseCoordinator;
}): Promise<IsolatedAttemptResult> {
	if ((options.agentArgv ? 1 : 0) + (options.agentExecutor ? 1 : 0) !== 1)
		throw new RepoArenaError(
			"CONFIG_INVALID",
			"Exactly one agent execution strategy is required.",
		);
	const agentWorkspace = await mkdtemp(join(tmpdir(), "repoarena-agent-"));
	const redactor = new SecretRedactor([...(options.secrets ?? [])]);
	const history: { state: AttemptState; at: string }[] = [];
	const move = (state: AttemptState) => {
		const current = history.at(-1)?.state;
		if (current) transitionAttempt(current, state);
		history.push({ state, at: new Date().toISOString() });
	};
	const cancelledResult = (): IsolatedAttemptResult => ({
		schema: "repoarena.attempt/v1",
		id: contentHash({
			task: options.task.id,
			agent: options.agentArgv ?? ["custom-executor"],
			at: history[0]?.at,
		}).slice(0, 24),
		state_history: history,
		patch: "",
		changed_files: [],
		public_verification: [],
		private_verification: { passed: 0, failed: 0 },
		evaluation: evaluate({
			public_checks: [],
			private_checks: [],
			integrity: [],
			cancelled: true,
		}),
		artifacts: [],
	});
	const stopIfCancelled = (): IsolatedAttemptResult | undefined => {
		if (!options.signal?.aborted) return undefined;
		move("CANCELLED");
		return cancelledResult();
	};
	move("QUEUED");
	const queuedCancellation = stopIfCancelled();
	if (queuedCancellation) return queuedCancellation;
	move("PREPARING");
	try {
		await cp(resolve(options.root), agentWorkspace, {
			recursive: true,
			filter: (entry) =>
				!isTransientStoreFile(entry) &&
				!relative(options.root, entry).startsWith(".repoarena/state") &&
				!relative(options.root, entry).startsWith(".repoarena/tasks") &&
				!relative(options.root, entry).startsWith("node_modules"),
		});
		const preparingCancellation = stopIfCancelled();
		if (preparingCancellation) return preparingCancellation;
		const sandbox = options.sandbox ?? options.sandboxFactory?.(agentWorkspace);
		move("SETUP");
		move("AGENT_RUNNING");
		const execute = async (
			argv: readonly string[],
			cwd: string,
			timeout: number,
		) => {
			if (!sandbox) return runArgv([...argv], cwd, timeout, options.signal);
			const result = await sandbox.execute({
				argv: [...argv],
				cwd,
				env: { REPOARENA_NETWORK_POLICY: options.task.execution.network.mode },
				timeout_seconds: timeout,
				...(options.signal ? { signal: options.signal } : {}),
			});
			return {
				command: JSON.stringify(argv),
				exit_code: result.exit_code,
				duration_ms: result.duration_ms,
				stdout: result.stdout,
				stderr: result.stderr,
				timed_out: result.timed_out,
				...(result.cancelled === undefined
					? {}
					: { cancelled: result.cancelled }),
			};
		};
		const releaseAgent = await options.phaseCoordinator?.enterAgent();
		let agent: CommandEvidence;
		try {
			agent = options.agentExecutor
				? await options.agentExecutor(agentWorkspace)
				: await execute(
						options.agentArgv ?? [],
						agentWorkspace,
						options.task.execution.timeout_seconds,
					);
		} finally {
			releaseAgent?.();
		}
		const safeAgent = {
			...agent,
			command: redactor.redact(agent.command),
			stdout: redactor.redact(agent.stdout),
			stderr: redactor.redact(agent.stderr),
		};
		if (agent.cancelled || options.signal?.aborted) {
			move("CANCELLED");
			return cancelledResult();
		}
		if (agent.exit_code !== 0 || agent.timed_out) {
			move(agent.timed_out ? "TIMED_OUT" : "FAILED");
			const result = evaluate({
				public_checks: [],
				private_checks: [],
				integrity: [],
				agent_failure: !agent.timed_out,
				agent_timeout: agent.timed_out,
			});
			return {
				schema: "repoarena.attempt/v1",
				id: contentHash({
					task: options.task.id,
					agent: options.agentArgv ?? ["custom-executor"],
					at: history[0]?.at,
				}).slice(0, 24),
				state_history: history,
				patch: "",
				changed_files: [],
				public_verification: [],
				private_verification: { passed: 0, failed: 0 },
				evaluation: result,
				artifacts: [],
				agent_execution: safeAgent,
				...(agent.usage ? { agent_usage: agent.usage } : {}),
			};
		}
		const agentCancellation = stopIfCancelled();
		if (agentCancellation) return agentCancellation;
		move("VERIFYING");
		const publicEvidence: CommandEvidence[] = [];
		for (const check of options.task.verification.required) {
			const evidence = Array.isArray(check.command)
				? await execute(check.command, agentWorkspace, check.timeout_seconds)
				: await runShell(
						check.command.command,
						agentWorkspace,
						check.timeout_seconds,
					);
			publicEvidence.push({
				...evidence,
				stdout: redactor.redact(evidence.stdout),
				stderr: redactor.redact(evidence.stderr),
			});
			if (evidence.cancelled || options.signal?.aborted) {
				move("CANCELLED");
				return cancelledResult();
			}
			if (evidence.exit_code !== 0 || evidence.timed_out) break;
		}
		move("COLLECTING");
		const repository = new GitRepository(agentWorkspace);
		const rawDiff = await repository.getWorkingTreeDiff();
		const diff = {
			...rawDiff,
			patch: redactor.redact(rawDiff.patch),
		};
		const privateEvidence: CommandEvidence[] = [];
		const releasePrivate = await options.phaseCoordinator?.enterPrivate();
		let privateWorkspace: string | null = null;
		try {
			privateWorkspace = await mkdtemp(join(tmpdir(), "repoarena-evaluator-"));
			// Agent process is already closed; do not introduce private data before here.
			await cp(agentWorkspace, privateWorkspace, { recursive: true });
			move("VERIFYING_PRIVATE");
			for (const argv of await (options.privateVerifier?.(
				privateWorkspace,
				options.privateData,
			) ?? Promise.resolve([])))
				privateEvidence.push(
					await runArgv(
						argv,
						privateWorkspace,
						options.task.execution.timeout_seconds,
						options.signal,
					),
				);
		} finally {
			if (privateWorkspace)
				await rm(privateWorkspace, { recursive: true, force: true });
			releasePrivate?.();
		}
		if (options.signal?.aborted) {
			move("CANCELLED");
			return cancelledResult();
		}
		const integrity = analyzeIntegrity(
			diff.changedFiles,
			options.integrityPolicy ?? {
				protected_paths: options.task.constraints.forbidden_paths,
				verification_paths: [
					"package.json",
					"pnpm-workspace.yaml",
					"vitest.config.ts",
					"jest.config.js",
				],
				forbid_test_deletion: true,
				forbid_verification_changes: true,
			},
		);
		const artifacts = options.artifactRequests?.length
			? await collectArtifactManifest(
					agentWorkspace,
					options.artifactRequests,
					undefined,
					(value) => redactor.redact(value),
				)
			: [];
		const evaluator = evaluate({
			public_checks: publicEvidence.map((item, index) =>
				verification(
					`public-${index}`,
					"public",
					item.exit_code === 0 && !item.timed_out,
					item.stdout,
					item.stderr,
				),
			),
			private_checks: privateEvidence.map((item, index) =>
				verification(
					`private-${index}`,
					"private",
					item.exit_code === 0 && !item.timed_out,
					item.stdout,
					item.stderr,
				),
			),
			integrity,
		});
		move("COMPLETED");
		return {
			schema: "repoarena.attempt/v1",
			id: contentHash({
				task: options.task.id,
				agent: options.agentArgv ?? ["custom-executor"],
				patch: diff.patch,
			}).slice(0, 24),
			state_history: history,
			patch: diff.patch,
			changed_files: diff.changedFiles,
			public_verification: publicEvidence,
			private_verification: evaluator.hidden,
			evaluation: evaluator,
			artifacts,
			agent_execution: safeAgent,
			...(agent.usage ? { agent_usage: agent.usage } : {}),
		};
	} finally {
		await rm(agentWorkspace, { recursive: true, force: true });
	}
}
export async function loadTask(path: string): Promise<Task> {
	const { taskSchema } = await import("@repoarena/task-spec");
	return taskSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
