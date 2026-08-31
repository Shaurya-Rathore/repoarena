import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
export type NetworkPolicy = "DISABLED" | "ALLOWLIST" | "UNRESTRICTED";
export type SandboxCommand = {
	argv: string[];
	cwd: string;
	env: Record<string, string>;
	timeout_seconds: number;
	signal?: AbortSignal;
};
export type SandboxResult = {
	argv: string[];
	cwd: string;
	stdout: string;
	stderr: string;
	exit_code: number | null;
	signal: string | null;
	timed_out: boolean;
	cancelled?: boolean;
	duration_ms: number;
};
export interface SandboxProvider {
	readonly id: string;
	capabilities(): {
		network_enforced: boolean;
		isolation: "process" | "container";
	};
	execute(command: SandboxCommand): Promise<SandboxResult>;
}
export class LocalSandboxProvider implements SandboxProvider {
	readonly id = "local";
	capabilities = () => ({
		network_enforced: false,
		isolation: "process" as const,
	});
	constructor(
		private readonly root: string,
		private readonly maxOutput = 100_000,
	) {}
	async execute(command: SandboxCommand): Promise<SandboxResult> {
		const root = await realpath(this.root);
		const cwd = await realpath(command.cwd);
		if (relative(root, cwd).startsWith(".."))
			throw new Error("Sandbox cwd escapes root");
		if (!command.argv.length) throw new Error("Sandbox argv required");
		return new Promise((resolveResult) => {
			const started = performance.now();
			const child = spawn(command.argv[0] ?? "", command.argv.slice(1), {
				cwd,
				env: { PATH: process.env.PATH ?? "", ...command.env },
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				detached: process.platform !== "win32",
			});
			let stdout = "";
			let stderr = "";
			let timed = false;
			let cancelled = command.signal?.aborted ?? false;
			const killTree = (signal: NodeJS.Signals) => {
				if (!child.pid) return;
				try {
					if (process.platform === "win32") child.kill(signal);
					else process.kill(-child.pid, signal);
				} catch {
					// The process tree may already have exited.
				}
			};
			const terminate = () => {
				killTree("SIGTERM");
				setTimeout(() => killTree("SIGKILL"), 250).unref();
			};
			const append = (old: string, value: string) => {
				const next = old + value;
				return next.length > this.maxOutput
					? `${next.slice(0, this.maxOutput)}\n[output truncated]`
					: next;
			};
			child.stdout.on("data", (c) => {
				stdout = append(stdout, String(c));
			});
			child.stderr.on("data", (c) => {
				stderr = append(stderr, String(c));
			});
			const timer = setTimeout(() => {
				timed = true;
				terminate();
			}, command.timeout_seconds * 1000);
			const onAbort = () => {
				cancelled = true;
				terminate();
			};
			command.signal?.addEventListener("abort", onAbort, { once: true });
			if (cancelled) terminate();
			child.on("error", (e) => {
				clearTimeout(timer);
				command.signal?.removeEventListener("abort", onAbort);
				killTree("SIGKILL");
				resolveResult({
					argv: command.argv,
					cwd,
					stdout,
					stderr: append(stderr, e.message),
					exit_code: null,
					signal: null,
					timed_out: timed,
					cancelled,
					duration_ms: Math.round(performance.now() - started),
				});
			});
			child.on("close", (code, signal) => {
				clearTimeout(timer);
				command.signal?.removeEventListener("abort", onAbort);
				killTree("SIGKILL");
				resolveResult({
					argv: command.argv,
					cwd,
					stdout,
					stderr,
					exit_code: code,
					signal,
					timed_out: timed,
					cancelled,
					duration_ms: Math.round(performance.now() - started),
				});
			});
		});
	}
}
