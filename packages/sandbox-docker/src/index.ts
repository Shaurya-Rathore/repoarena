import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
	SandboxCommand,
	SandboxProvider,
	SandboxResult,
} from "@repoarena/sandbox-local";
export type DockerCapability = {
	available: boolean;
	daemon: boolean;
	version: string | null;
	diagnostic?: string;
};
export const dockerCapability = async (): Promise<DockerCapability> =>
	new Promise((resolve) => {
		const p = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let out = "";
		let err = "";
		p.stdout.on("data", (c) => {
			out += String(c);
		});
		p.stderr.on("data", (c) => {
			err += String(c);
		});
		p.on("error", () =>
			resolve({
				available: false,
				daemon: false,
				version: null,
				diagnostic: "Docker executable unavailable",
			}),
		);
		p.on("close", (code) =>
			resolve(
				code === 0
					? { available: true, daemon: true, version: out.trim() || null }
					: {
							available: true,
							daemon: false,
							version: null,
							diagnostic: err.trim() || "Docker daemon unavailable",
						},
			),
		);
	});
export class DockerSandboxProvider implements SandboxProvider {
	readonly id = "docker";
	constructor(
		private readonly workspace: string,
		private readonly image = "node:24-bookworm-slim",
		private readonly resources: {
			cpu?: number;
			memory_mb?: number;
			pids?: number;
		} = {},
	) {}
	capabilities = () => ({
		network_enforced: true,
		isolation: "container" as const,
	});
	buildArgs(
		command: SandboxCommand,
		name = `ra-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
	): string[] {
		if (!command.argv.length) throw new Error("Sandbox argv required");
		const args = [
			"run",
			"--rm",
			"--name",
			name,
			"--workdir",
			"/workspace",
			"--user",
			"1000:1000",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--pids-limit",
			String(this.resources.pids ?? 128),
			"--network",
			command.env.REPOARENA_NETWORK_POLICY?.toLowerCase() === "unrestricted"
				? "bridge"
				: "none",
			"--mount",
			`type=bind,src=${this.workspace},dst=/workspace,rw`,
			"--tmpfs",
			"/tmp:rw,noexec,nosuid,size=64m",
		];
		if (this.resources.cpu) args.push("--cpus", String(this.resources.cpu));
		if (this.resources.memory_mb)
			args.push("--memory", `${this.resources.memory_mb}m`);
		for (const key of Object.keys(command.env).sort()) args.push("--env", key);
		args.push(this.image, ...command.argv);
		return args;
	}
	async execute(command: SandboxCommand): Promise<SandboxResult> {
		const name = `ra-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
		const args = this.buildArgs(command, name);
		return new Promise((resolve) => {
			const start = performance.now();
			const p = spawn("docker", args, {
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				env: { PATH: process.env.PATH ?? "", ...command.env },
			});
			let stdout = "";
			let stderr = "";
			let timed = false;
			let cancelled = command.signal?.aborted ?? false;
			const removeContainer = () => {
				const cleanup = spawn("docker", ["rm", "--force", name], {
					stdio: "ignore",
					shell: false,
					env: { PATH: process.env.PATH ?? "" },
				});
				cleanup.on("error", () => {
					// Capability diagnostics report Docker availability separately.
				});
				cleanup.unref();
			};
			const terminate = () => {
				removeContainer();
				p.kill("SIGTERM");
				setTimeout(() => p.kill("SIGKILL"), 250).unref();
			};
			p.stdout.on("data", (c) => {
				stdout += String(c);
			});
			p.stderr.on("data", (c) => {
				stderr += String(c);
			});
			const t = setTimeout(() => {
				timed = true;
				terminate();
			}, command.timeout_seconds * 1000);
			const onAbort = () => {
				cancelled = true;
				terminate();
			};
			command.signal?.addEventListener("abort", onAbort, { once: true });
			if (cancelled) terminate();
			p.on("close", (code, signal) => {
				clearTimeout(t);
				command.signal?.removeEventListener("abort", onAbort);
				resolve({
					argv: command.argv,
					cwd: command.cwd,
					stdout: stdout.slice(0, 100000),
					stderr: stderr.slice(0, 100000),
					exit_code: code,
					signal,
					timed_out: timed,
					cancelled,
					duration_ms: Math.round(performance.now() - start),
				});
			});
			p.on("error", (e) => {
				clearTimeout(t);
				command.signal?.removeEventListener("abort", onAbort);
				removeContainer();
				resolve({
					argv: command.argv,
					cwd: command.cwd,
					stdout,
					stderr: e.message,
					exit_code: null,
					signal: null,
					timed_out: false,
					cancelled,
					duration_ms: Math.round(performance.now() - start),
				});
			});
		});
	}
}
