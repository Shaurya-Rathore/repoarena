import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assessRepository } from "./index.js";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const fixture = async (files: Record<string, string>) => { const root = await mkdtemp(join(tmpdir(), "repoarena-ready-")); roots.push(root); for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content); } return root; };
it("scores a reproducible repository deterministically", async () => {
	const root = await fixture({ ".git/HEAD": "ref: refs/heads/main\n", ".repoarena/config.yaml": "schema: repoarena.config/v1\n", ".repoarena/tasks/task.yaml": "task", "AGENTS.md": "Run pnpm verify.", "README.md": "setup build test", ".env.example": "DATABASE_URL=", "fixtures/input.txt": "fixture", "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest", "test:unit": "vitest", verify: "pnpm test" } }), "pnpm-lock.yaml": "lockfileVersion: 9", "src/example.test.ts": "test('ok',()=>{})" });
	const first = await assessRepository(root, { now: "2026-01-01T00:00:00.000Z" });
	const second = await assessRepository(root, { now: "2026-01-01T00:00:00.000Z" });
	expect(first).toEqual(second); expect(first.score).toBe(100); expect(first.status).toBe("READY");
});
it("explains missing tests, environment, guidance, services, monorepo and generated code", async () => {
	const root = await fixture({ ".git/HEAD": "main", "README.md": "docs", "package.json": JSON.stringify({ scripts: { start: "node app", "test:slow": "curl https://example.invalid/fixture", "test:flaky": "runner --retry 3" } }), "packages/a/package.json": "{}", "packages/b/package.json": "{}", "packages/c/package.json": "{}", "packages/d/package.json": "{}", "migrations/001.sql": "create table example(id int);", "src/generated/client.ts": "generated" });
	const report = await assessRepository(root, { now: "2026-01-01T00:00:00.000Z" });
	expect(report.findings.map((item) => item.id)).toEqual(expect.arrayContaining(["tests.missing", "tests.slow-suite", "tests.flaky-signal", "environment.unspecified", "environment.network-assumption", "agent-guidance.missing", "dependencies.services", "complexity.monorepo", "complexity.generated"]));
	expect(report.score).toBeLessThan(70); expect(report.status).toBe("BLOCKED"); expect(report.findings.every((item) => item.evidence && item.recommendation)).toBe(true);
});
