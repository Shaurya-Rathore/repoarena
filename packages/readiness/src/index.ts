import {
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { contentHash } from "@repoarena/core";

export type ReadinessSeverity = "INFO" | "WARNING" | "ERROR";
export type ReadinessCategory =
	| "setup"
	| "tests"
	| "documentation"
	| "environment"
	| "dependencies"
	| "fixtures"
	| "complexity"
	| "agent_guidance";
export type ReadinessFinding = Readonly<{
	id: string;
	category: ReadinessCategory;
	severity: ReadinessSeverity;
	impact: number;
	title: string;
	evidence: string;
	recommendation: string;
	path: string | null;
}>;
export type ReadinessDimension = Readonly<{
	id: ReadinessCategory;
	score: number;
	max: number;
	evidence: string;
	remediation?: string;
}>;
export type ReadinessReport = Readonly<{
	schema: "repoarena.readiness/v1";
	id: string;
	repository_fingerprint: string;
	created_at: string;
	score: number;
	status: "READY" | "NEEDS_ATTENTION" | "BLOCKED";
	dimensions: readonly ReadinessDimension[];
	findings: readonly ReadinessFinding[];
}>;
type RepositorySignals = {
	files: string[];
	packageJson: Record<string, unknown> | null;
	hasGit: boolean;
	hasConfig: boolean;
	hasTasks: boolean;
};
const ignored = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".next",
	"coverage",
]);
const walk = async (
	root: string,
	current = root,
	result: string[] = [],
): Promise<string[]> => {
	if (result.length >= 5_000) return result;
	let entries: Dirent[];
	try {
		entries = await readdir(current, { withFileTypes: true });
	} catch {
		return result;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (ignored.has(entry.name)) continue;
		const absolute = join(current, entry.name);
		const logical = relative(root, absolute);
		if (entry.isSymbolicLink()) result.push(logical);
		else if (entry.isDirectory()) await walk(root, absolute, result);
		else if (entry.isFile()) result.push(logical);
		if (result.length >= 5_000) break;
	}
	return result;
};
const hasAny = (files: readonly string[], patterns: readonly RegExp[]) =>
	files.some((file) => patterns.some((pattern) => pattern.test(file)));
const finding = (
	id: string,
	category: ReadinessCategory,
	severity: ReadinessSeverity,
	impact: number,
	title: string,
	evidence: string,
	recommendation: string,
	path: string | null = null,
): ReadinessFinding => ({
	id,
	category,
	severity,
	impact,
	title,
	evidence,
	recommendation,
	path,
});
const categoryMax: Record<ReadinessCategory, number> = {
	setup: 18,
	tests: 22,
	documentation: 10,
	environment: 12,
	dependencies: 12,
	fixtures: 8,
	complexity: 8,
	agent_guidance: 10,
};
const scripts = (signals: RepositorySignals): Record<string, string> => {
	const value = signals.packageJson?.scripts;
	if (!value || typeof value !== "object") return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
};
const analyze = (signals: RepositorySignals): ReadinessFinding[] => {
	const files = signals.files;
	const commands = scripts(signals);
	const findings: ReadinessFinding[] = [];
	if (!signals.hasGit)
		findings.push(
			finding(
				"setup.git-missing",
				"setup",
				"ERROR",
				12,
				"Git repository missing",
				"No .git directory was found.",
				"Run git init and commit a reproducible base state.",
			),
		);
	if (!signals.hasConfig)
		findings.push(
			finding(
				"setup.repoarena-config",
				"setup",
				"WARNING",
				4,
				"RepoArena is not initialized",
				".repoarena/config.yaml was not found.",
				"Run repoarena init.",
			),
		);
	if (!Object.keys(commands).some((key) => /^(build|compile|check)$/.test(key)))
		findings.push(
			finding(
				"setup.build-command",
				"setup",
				"WARNING",
				3,
				"No standard build command",
				"No build, compile, or check script is declared.",
				"Declare a deterministic build/check command.",
				"package.json",
			),
		);
	const testFiles = hasAny(files, [
		/(^|\/)(__tests__|tests?|specs?)(\/|\.)/i,
		/\.(test|spec)\.[cm]?[jt]sx?$/,
	]);
	const testCommand = Object.keys(commands).some((key) =>
		/^(test|verify|check)$/.test(key),
	);
	if (!testFiles || !testCommand)
		findings.push(
			finding(
				"tests.missing",
				"tests",
				"ERROR",
				16,
				"Automated tests are incomplete",
				`${testFiles ? "Test files exist" : "No test files found"}; ${testCommand ? "a test command exists" : "no test command exists"}.`,
				"Add deterministic tests and a standard test command.",
			),
		);
	if (
		!Object.keys(commands).some((key) =>
			/test:(unit|integration)|verify/.test(key),
		)
	)
		findings.push(
			finding(
				"tests.layers",
				"tests",
				"WARNING",
				3,
				"Test layers are not explicit",
				"No unit/integration/verify script convention was detected.",
				"Separate fast deterministic checks from slower integration checks.",
			),
		);
	if (Object.keys(commands).some((key) => /slow|e2e/.test(key)))
		findings.push(
			finding(
				"tests.slow-suite",
				"tests",
				"INFO",
				1,
				"Slow test layer detected",
				"A slow or end-to-end test script is declared.",
				"Keep a fast deterministic verification subset for agent feedback.",
			),
		);
	if (
		Object.entries(commands).some(([key, command]) =>
			/flaky|retry/.test(`${key} ${command}`),
		)
	)
		findings.push(
			finding(
				"tests.flaky-signal",
				"tests",
				"WARNING",
				3,
				"Potential flaky-test retry detected",
				"A test script references flaky or retry behavior.",
				"Remove nondeterminism or isolate and report flaky checks explicitly.",
			),
		);
	if (!hasAny(files, [/^README(\.|$)/i]))
		findings.push(
			finding(
				"documentation.readme",
				"documentation",
				"WARNING",
				6,
				"Repository documentation missing",
				"No root README was found.",
				"Document setup, build, test, and service requirements.",
			),
		);
	if (
		!hasAny(files, [
			/(^|\/)(\.env\.example|\.env\.sample|devcontainer\.json|Dockerfile|compose\.ya?ml)$/i,
		])
	)
		findings.push(
			finding(
				"environment.unspecified",
				"environment",
				"WARNING",
				7,
				"Environment is not specified",
				"No environment example, container, or compose definition was detected.",
				"Provide a checked-in environment contract such as .env.example.",
			),
		);
	if (
		Object.values(commands).some((command) =>
			/\b(curl|wget)\b|https?:\/\//i.test(command),
		)
	)
		findings.push(
			finding(
				"environment.network-assumption",
				"environment",
				"WARNING",
				3,
				"Command assumes network access",
				"A repository command invokes a URL or network download tool.",
				"Pin downloaded inputs and document which benchmark phases require network access.",
			),
		);
	const manifests = files.filter((file) =>
		[
			"package.json",
			"pyproject.toml",
			"Cargo.toml",
			"go.mod",
			"pom.xml",
		].includes(basename(file)),
	);
	if (manifests.length === 0)
		findings.push(
			finding(
				"dependencies.manifest",
				"dependencies",
				"ERROR",
				8,
				"Dependency manifest missing",
				"No supported dependency manifest was found.",
				"Check in a dependency manifest and lockfile.",
			),
		);
	const lock = hasAny(files, [
		/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|uv\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/,
	]);
	if (manifests.length > 0 && !lock)
		findings.push(
			finding(
				"dependencies.lockfile",
				"dependencies",
				"WARNING",
				5,
				"Dependency versions are not locked",
				"A dependency manifest exists without a recognized lockfile.",
				"Commit the ecosystem lockfile.",
			),
		);
	if (
		hasAny(files, [
			/(^|\/)(docker-compose|compose)\.ya?ml$/i,
			/(^|\/)migrations?\//i,
		])
	)
		findings.push(
			finding(
				"dependencies.services",
				"dependencies",
				"WARNING",
				2,
				"External services require setup",
				"Compose or database migrations indicate service dependencies.",
				"Document startup, readiness, reset, and fixture commands.",
			),
		);
	if (!hasAny(files, [/(^|\/)(fixtures?|testdata|seed)(\/|\.)/i]))
		findings.push(
			finding(
				"fixtures.missing",
				"fixtures",
				"INFO",
				3,
				"No deterministic fixture directory detected",
				"No fixture, testdata, or seed path was found.",
				"Add small deterministic fixtures for benchmark verification.",
			),
		);
	if (manifests.length > 4)
		findings.push(
			finding(
				"complexity.monorepo",
				"complexity",
				"WARNING",
				3,
				"Multi-package setup detected",
				`${manifests.length} dependency manifests were found.`,
				"Document workspace-scoped install, build, and test commands.",
			),
		);
	if (files.length >= 5_000)
		findings.push(
			finding(
				"complexity.large-tree",
				"complexity",
				"WARNING",
				3,
				"Repository tree is large",
				"Readiness scanning reached the 5,000-file safety bound.",
				"Document generated/vendor paths and exclude them from agent context.",
			),
		);
	if (hasAny(files, [/(^|\/)(generated|gen)(\/|\.)/i, /\.generated\./i]))
		findings.push(
			finding(
				"complexity.generated",
				"complexity",
				"INFO",
				2,
				"Generated code detected",
				"Generated paths may increase context and patch noise.",
				"Document regeneration commands and protected generated paths.",
			),
		);
	if (!hasAny(files, [/(^|\/)AGENTS\.md$/]))
		findings.push(
			finding(
				"agent-guidance.missing",
				"agent_guidance",
				"WARNING",
				7,
				"Agent instructions missing",
				"No AGENTS.md was detected.",
				"Add concise repository-specific build, test, and safety instructions.",
			),
		);
	if (!signals.hasTasks)
		findings.push(
			finding(
				"agent-guidance.tasks",
				"agent_guidance",
				"INFO",
				2,
				"No benchmark task catalog",
				".repoarena/tasks was not found.",
				"Discover or author validated benchmark tasks.",
			),
		);
	return findings.sort((a, b) => a.id.localeCompare(b.id));
};
export async function assessRepository(
	root: string,
	options: { now?: string } = {},
): Promise<ReadinessReport> {
	const files = await walk(root);
	const readJson = async (): Promise<Record<string, unknown> | null> => {
		try {
			return JSON.parse(
				await readFile(join(root, "package.json"), "utf8"),
			) as Record<string, unknown>;
		} catch {
			return null;
		}
	};
	const exists = async (path: string): Promise<boolean> =>
		stat(path)
			.then(() => true)
			.catch(() => false);
	const signals: RepositorySignals = {
		files,
		packageJson: await readJson(),
		hasGit: await exists(join(root, ".git")),
		hasConfig: await exists(join(root, ".repoarena", "config.yaml")),
		hasTasks: await exists(join(root, ".repoarena", "tasks")),
	};
	const findings = analyze(signals);
	const dimensions = (
		Object.entries(categoryMax) as [ReadinessCategory, number][]
	).map(([id, max]) => {
		const categoryFindings = findings.filter((item) => item.category === id);
		return {
			id,
			score: Math.max(
				0,
				max - categoryFindings.reduce((sum, item) => sum + item.impact, 0),
			),
			max,
			evidence: categoryFindings.length
				? `${categoryFindings.length} finding(s).`
				: "No deterministic readiness findings.",
			...(categoryFindings[0]
				? { remediation: categoryFindings[0].recommendation }
				: {}),
		};
	});
	const score = dimensions.reduce((sum, item) => sum + item.score, 0);
	const fingerprint = contentHash({ files, dimensions, findings });
	return {
		schema: "repoarena.readiness/v1",
		id: fingerprint.slice(0, 24),
		repository_fingerprint: fingerprint,
		created_at: options.now ?? new Date().toISOString(),
		score,
		status: findings.some((item) => item.severity === "ERROR")
			? "BLOCKED"
			: score >= 80
				? "READY"
				: "NEEDS_ATTENTION",
		dimensions,
		findings,
	};
}

export async function writeReadinessReportAtomic(
	path: string,
	report: ReadinessReport,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(
		dirname(path),
		`.readiness-${crypto.randomUUID()}.tmp`,
	);
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(report)}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
