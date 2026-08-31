import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadConfig, writeConfigAtomic } from "@repoarena/config";
import { RepoArenaError } from "@repoarena/core";
import { GitRepository } from "@repoarena/git";
import { exportRecommendedProfile, optimize, searchSpaceSchema, type OptimizationRun, type TrialExecutor } from "@repoarena/optimizer";
import { assessRepository, type ReadinessReport } from "@repoarena/readiness";
import { loadRun, type PersistedRun } from "@repoarena/run-store";
import { taskSchema, toAgentVisibleTask, type AgentVisibleTask, type Task } from "@repoarena/task-spec";
import { parse } from "yaml";
import { z } from "zod";
import { html } from "./assets.js";

export type LocalProductOptions = Readonly<{
	root: string;
	host?: "127.0.0.1" | "localhost";
	port?: number;
	version?: string;
	optimizerExecutor?: TrialExecutor;
}>;
export type LocalProductServer = Readonly<{
	server: Server;
	csrfToken: string;
	start(): Promise<{ host: string; port: number; url: string }>;
	close(): Promise<void>;
}>;
type LocalPublicTask = Readonly<
	AgentVisibleTask & {
		validation: Task["validation"];
		provenance: Task["provenance"];
		source: AgentVisibleTask["source"] & Pick<Task["source"], "issue_url" | "pr_url" | "discovery">;
	}
>;
const querySchema = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50), search: z.string().max(200).default("") });
const taskQuerySchema = querySchema.extend({ source: z.string().max(40).default(""), status: z.string().max(40).default(""), min_quality: z.coerce.number().min(0).max(1).default(0) });
const runQuerySchema = querySchema.extend({ agent: z.string().max(100).default(""), model: z.string().max(200).default(""), status: z.string().max(40).default(""), from: z.string().max(40).default(""), to: z.string().max(40).default("") });
const json = (response: ServerResponse, status: number, value: unknown) => {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(`${JSON.stringify(value)}\n`);
};
const safeError = (response: ServerResponse, error: unknown) => {
	const known = error instanceof RepoArenaError;
	const invalid = error instanceof z.ZodError;
	json(response, known || invalid ? 400 : 500, { schema: "repoarena.local-error/v1", error: { code: known ? error.code : invalid ? "VALIDATION_FAILED" : "LOCAL_API_FAILED", message: known ? error.message : invalid ? "Local API input failed validation." : "The local operation failed." } });
};
const readBody = async (request: IncomingMessage): Promise<unknown> => {
	let body = "";
	for await (const chunk of request) {
		body += String(chunk);
		if (body.length > 1_000_000) throw new RepoArenaError("CONFIG_INVALID", "Request body is too large.");
	}
	try { return JSON.parse(body || "null") as unknown; } catch { throw new RepoArenaError("CONFIG_INVALID", "Request body must be valid JSON."); }
};
const files = async (directory: string, pattern: RegExp) => {
	try { return (await readdir(directory)).filter((file) => pattern.test(file)).sort(); } catch { return []; }
};
const atomicJson = async (path: string, value: unknown) => {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
	const file = await open(temporary, "wx", 0o600);
	try { await file.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await file.sync(); } finally { await file.close(); }
	try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
};
const publicRun = (run: PersistedRun): PersistedRun => ({ ...run, attempts: run.attempts.map((attempt) => ({ ...attempt, artifacts: attempt.artifacts.filter((artifact) => artifact.visibility !== "EVALUATOR_PRIVATE") })) });
const runSummary = (run: PersistedRun) => {
	const groups = new Map<string, { id: string; model: string | null; attempts: number; solved: number; duration_ms: number; cost_micros: number }>();
	for (const attempt of run.attempts) {
		const key = `${attempt.agent.id}\0${attempt.agent.model ?? ""}`;
		const group = groups.get(key) ?? { id: attempt.agent.id, model: attempt.agent.model, attempts: 0, solved: 0, duration_ms: 0, cost_micros: 0 };
		group.attempts++; group.solved += attempt.evaluation.outcome === "SOLVED" ? 1 : 0; group.duration_ms += attempt.duration_ms; group.cost_micros += attempt.cost.micros ?? 0; groups.set(key, group);
	}
	return { schema: run.schema, id: run.id, status: run.status, repository: run.repository, configuration: run.configuration, statistics: run.statistics, created_at: run.created_at, updated_at: run.updated_at, agents: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id) || (a.model ?? "").localeCompare(b.model ?? "")) };
};

export function createLocalProductServer(options: LocalProductOptions): LocalProductServer {
	const host = options.host ?? "127.0.0.1";
	const csrfToken = crypto.randomUUID();
	let address: { host: string; port: number; url: string } | null = null;
	const taskDirectory = join(options.root, ".repoarena", "tasks");
	const runsDirectory = join(options.root, ".repoarena", "state", "runs");
	const readinessDirectory = join(options.root, ".repoarena", "state", "readiness");
	const optimizationDirectory = join(options.root, ".repoarena", "state", "optimizations");
	const readTasks = async (): Promise<LocalPublicTask[]> => Promise.all((await files(taskDirectory, /\.(json|ya?ml)$/i)).map(async (file) => {
		const raw = await readFile(join(taskDirectory, file), "utf8");
		const task = taskSchema.parse(file.endsWith(".json") ? JSON.parse(raw) : parse(raw));
		const visible = toAgentVisibleTask(task);
		return {
			...visible,
			source: { ...visible.source, issue_url: task.source.issue_url, pr_url: task.source.pr_url, discovery: task.source.discovery },
			validation: task.validation,
			provenance: task.provenance,
		};
	}));
	const readRuns = async (): Promise<PersistedRun[]> => {
		const values = await Promise.all((await files(runsDirectory, /\.json$/)).map((file) => loadRun(join(runsDirectory, file)).catch(() => null)));
		const unique = new Map(values.filter((item): item is PersistedRun => item !== null).map((run) => [run.id, publicRun(run)]));
		return [...unique.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
	};
	const readOptimizations = async (): Promise<OptimizationRun[]> => {
		const values: OptimizationRun[] = [];
		for (const file of await files(optimizationDirectory, /\.json$/)) {
			try {
				const value = JSON.parse(await readFile(join(optimizationDirectory, file), "utf8")) as OptimizationRun;
				if (value.schema === "repoarena.optimization-run/v1") values.push(value);
			} catch { /* corrupt history is omitted from lists, never fabricated */ }
		}
		return values.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
	};
	const readReadinessHistory = async (): Promise<ReadinessReport[]> => {
		const values: ReadinessReport[] = [];
		for (const file of await files(readinessDirectory, /\.json$/)) {
			try {
				const value = JSON.parse(await readFile(join(readinessDirectory, file), "utf8")) as ReadinessReport;
				if (value.schema === "repoarena.readiness/v1") values.push(value);
			} catch { /* corrupt history is omitted from lists, never fabricated */ }
		}
		return [...new Map(values.map((value) => [value.id, value])).values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
	};
	const mutationAllowed = (request: IncomingMessage) => {
		const origin = request.headers.origin;
		const validOrigin = typeof origin === "string" && (origin === address?.url || origin.startsWith("http://localhost:"));
		return validOrigin && request.headers["x-repoarena-csrf"] === csrfToken && request.headers["content-type"]?.startsWith("application/json");
	};
	const server = createServer(async (request, response) => {
		response.setHeader("x-content-type-options", "nosniff");
		response.setHeader("referrer-policy", "no-referrer");
		response.setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
		try {
			const url = new URL(request.url ?? "/", address?.url ?? `http://${host}`);
			if (url.pathname === "/health") return json(response, 200, { status: "ok", schema: "repoarena.local-health/v1" });
			if (!url.pathname.startsWith("/api/v1/")) {
				response.setHeader("content-type", "text/html; charset=utf-8");
				response.end(html(csrfToken));
				return;
			}
			const path = url.pathname.slice("/api/v1".length);
			if (request.method === "GET" && path === "/repository") {
				let identity: { head: string; remote: string | null } | null = null;
				try { identity = await new GitRepository(options.root).identity(); } catch { /* onboarding state */ }
				let branch = "unavailable";
				try { branch = (await readFile(join(options.root, ".git", "HEAD"), "utf8")).trim().replace("ref: refs/heads/", ""); } catch { /* onboarding state */ }
				const initialized = await stat(join(options.root, ".repoarena", "config.yaml")).then(() => true).catch(() => false);
				return json(response, 200, { data: { schema: "repoarena.local-repository/v1", name: basename(options.root), root_label: basename(options.root), initialized, branch, commit: identity?.head ?? null, remote: identity?.remote ?? null, version: options.version ?? "0.1.0" } });
			}
			if (request.method === "GET" && path === "/configuration") return json(response, 200, { data: await loadConfig(options.root) });
			if (request.method === "PUT" && path === "/configuration") {
				if (!mutationAllowed(request)) return json(response, 403, { error: { code: "FORBIDDEN", message: "Same-origin CSRF validation failed." } });
				return json(response, 200, { data: await writeConfigAtomic(options.root, await readBody(request)) });
			}
			if (request.method === "GET" && path === "/tasks") {
				const query = taskQuerySchema.parse(Object.fromEntries(url.searchParams));
				const all = (await readTasks()).filter((task) => `${task.id} ${task.title} ${task.metadata.tags.join(" ")}`.toLowerCase().includes(query.search.toLowerCase()) && (!query.source || task.source.type === query.source) && (!query.status || task.validation.status === query.status) && (task.metadata.quality_score ?? 0) >= query.min_quality);
				const items = all.slice(query.offset, query.offset + query.limit).map((task) => ({ id: task.id, title: task.title, source: task.source, validation: task.validation, metadata: task.metadata }));
				return json(response, 200, { data: { items, total: all.length, offset: query.offset, limit: query.limit } });
			}
			const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
			if (request.method === "GET" && taskMatch?.[1]) {
				const task = (await readTasks()).find((item) => item.id === decodeURIComponent(taskMatch[1] ?? ""));
				return task ? json(response, 200, { data: task }) : json(response, 404, { error: { code: "TASK_NOT_FOUND", message: "Task was not found." } });
			}
			if (request.method === "GET" && path === "/runs") {
				const query = runQuerySchema.parse(Object.fromEntries(url.searchParams)); const all = (await readRuns()).filter((run) => (!query.status || run.status === query.status) && (!query.agent || run.attempts.some((attempt) => attempt.agent.id === query.agent)) && (!query.model || run.attempts.some((attempt) => attempt.agent.model === query.model)) && (!query.from || run.created_at >= query.from) && (!query.to || run.created_at <= query.to));
				return json(response, 200, { data: { items: all.slice(query.offset, query.offset + query.limit).map(runSummary), total: all.length, offset: query.offset, limit: query.limit } });
			}
			const runMatch = path.match(/^\/runs\/([^/]+)$/);
			if (request.method === "GET" && runMatch?.[1]) { const run = (await readRuns()).find((item) => item.id === decodeURIComponent(runMatch[1] ?? "")); return run ? json(response, 200, { data: run }) : json(response, 404, { error: { code: "RUN_NOT_FOUND", message: "Run was not found." } }); }
			const attemptMatch = path.match(/^\/attempts\/([^/]+)$/);
			if (request.method === "GET" && attemptMatch?.[1]) { const attempt = (await readRuns()).flatMap((run) => run.attempts).find((item) => item.id === decodeURIComponent(attemptMatch[1] ?? "")); return attempt ? json(response, 200, { data: attempt }) : json(response, 404, { error: { code: "ATTEMPT_NOT_FOUND", message: "Attempt was not found." } }); }
			if (request.method === "GET" && path === "/readiness") { try { const value = JSON.parse(await readFile(join(readinessDirectory, "latest.json"), "utf8")) as ReadinessReport; return json(response, 200, { data: value }); } catch { return json(response, 200, { data: null }); } }
			if (request.method === "GET" && path === "/readiness/history") { const query = querySchema.parse(Object.fromEntries(url.searchParams)); const all = await readReadinessHistory(); return json(response, 200, { data: { items: all.slice(query.offset, query.offset + query.limit), total: all.length, offset: query.offset, limit: query.limit } }); }
			if (request.method === "POST" && path === "/readiness") { if (!mutationAllowed(request)) return json(response, 403, { error: { code: "FORBIDDEN", message: "Same-origin CSRF validation failed." } }); const report = await assessRepository(options.root); await atomicJson(join(readinessDirectory, `${report.id}.json`), report); await atomicJson(join(readinessDirectory, "latest.json"), report); return json(response, 201, { data: report }); }
			if (request.method === "GET" && path === "/optimizations") { const query = querySchema.parse(Object.fromEntries(url.searchParams)); const all = await readOptimizations(); return json(response, 200, { data: { items: all.slice(query.offset, query.offset + query.limit), total: all.length, offset: query.offset, limit: query.limit } }); }
			const optimizationMatch = path.match(/^\/optimizations\/([^/]+)$/);
			if (request.method === "GET" && optimizationMatch?.[1]) { const value = (await readOptimizations()).find((item) => item.id === decodeURIComponent(optimizationMatch[1] ?? "")); return value ? json(response, 200, { data: value }) : json(response, 404, { error: { code: "OPTIMIZATION_NOT_FOUND", message: "Optimization run was not found." } }); }
			if (request.method === "POST" && path === "/optimizations") {
				if (!mutationAllowed(request)) return json(response, 403, { error: { code: "FORBIDDEN", message: "Same-origin CSRF validation failed." } });
				if (!options.optimizerExecutor) return json(response, 409, { error: { code: "OPTIMIZER_UNAVAILABLE", message: "This server was not configured with a trial executor." } });
				const space = searchSpaceSchema.parse(await readBody(request));
				const identity = await new GitRepository(options.root).identity();
				const run = await optimize({ searchSpace: space, repositoryCommit: identity.head, runnerVersion: options.version ?? "0.1.0", executor: options.optimizerExecutor });
				await atomicJson(join(optimizationDirectory, `${run.id}.json`), run); return json(response, 201, { data: run });
			}
			const profileMatch = path.match(/^\/optimizations\/([^/]+)\/profile$/);
			if (request.method === "GET" && profileMatch?.[1]) { const value = (await readOptimizations()).find((item) => item.id === decodeURIComponent(profileMatch[1] ?? "")); if (!value) return json(response, 404, { error: { code: "OPTIMIZATION_NOT_FOUND", message: "Optimization run was not found." } }); response.setHeader("content-type", "application/yaml; charset=utf-8"); response.setHeader("content-disposition", `attachment; filename="repoarena-profile-${value.id}.yaml"`); response.end(exportRecommendedProfile(value)); return; }
			return json(response, 404, { error: { code: "NOT_FOUND", message: "Local API route was not found." } });
		} catch (error) { safeError(response, error); }
	});
	return {
		server,
		csrfToken,
		start: () => new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 4177, host, () => {
				const bound = server.address(); if (!bound || typeof bound === "string") return reject(new Error("local server address unavailable"));
				address = { host, port: bound.port, url: `http://${host}:${bound.port}` }; resolve(address);
			});
		}),
		close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}
