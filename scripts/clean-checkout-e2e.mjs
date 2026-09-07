import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const temporary = await mkdtemp(join(tmpdir(), "repoarena-clean-checkout-"));
const checkout = join(temporary, "source");
const run = (command, args, cwd = root) =>
	execFileSync(command, args, {
		cwd,
		stdio: "inherit",
		env: { ...process.env, CI: "1" },
	});
try {
	run("git", ["worktree", "add", "--detach", checkout, "HEAD"]);
	run("pnpm", ["install", "--frozen-lockfile"], checkout);
	run("pnpm", ["build"], checkout);
	const version = execFileSync(
		process.execPath,
		[join(checkout, "packages", "cli", "dist", "index.cjs"), "--version"],
		{ cwd: checkout, encoding: "utf8" },
	).trim();
	if (version !== "1.0.0")
		throw new Error(`Clean checkout built CLI ${version}`);
	process.stdout.write("CLEAN_CHECKOUT_E2E_OK\n");
} finally {
	execFileSync("git", ["worktree", "remove", "--force", checkout], {
		cwd: root,
		stdio: "ignore",
	});
	await rm(temporary, { recursive: true, force: true });
}
