import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const run = (command, args, env = process.env) =>
	execFileSync(command, args, { cwd: root, stdio: "inherit", env });
const databaseEnvironment = { ...process.env };
if (!databaseEnvironment.DATABASE_URL)
	throw new Error("release:verify requires canonical DATABASE_URL");

run("pg_isready", []);
run("pnpm", ["format:check"]);
run("pnpm", ["lint"]);
run("pnpm", ["typecheck"]);
run("pnpm", ["skills:validate"]);
run("pnpm", ["release:secret-scan"]);
run("pnpm", ["audit", "--prod", "--audit-level", "low"]);
run("pnpm", ["verify"]);
run("pnpm", ["test:integration"], databaseEnvironment);
run(
	"pnpm",
	["--filter", "@repoarena/cloud-product", "test:e2e"],
	databaseEnvironment,
);
run("pnpm", ["--filter", "@repoarena/github-action", "test:e2e"]);
run("pnpm", ["test:cloud-product-built"]);
run("node", ["scripts/backup-restore-e2e.mjs"], databaseEnvironment);
run("pnpm", ["release:dry-run"]);
run("node", ["scripts/packed-cli-e2e.mjs"]);
run("node", ["scripts/release-security.mjs"]);
run("node", ["scripts/license-audit.mjs"]);
run("node", ["scripts/clean-checkout-e2e.mjs"]);
run("node", ["scripts/release-performance.mjs"]);
process.stdout.write("RELEASE_VERIFY_OK\n");
