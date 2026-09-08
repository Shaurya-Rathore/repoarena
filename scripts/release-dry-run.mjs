import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const output = join(root, "release-artifacts");
const run = (command, args, options = {}) =>
	execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
run("pnpm", ["build"]);
execFileSync("pnpm", ["pack", "--pack-destination", output], {
	cwd: join(root, "packages", "cli"),
	stdio: "inherit",
});
run("tar", [
	"-czf",
	join(output, "repoarena-action-1.0.0.tgz"),
	"-C",
	join(root, "actions", "repoarena"),
	"action.yml",
	"dist",
]);

const artifacts = (await readdir(output))
	.filter((name) => name.endsWith(".tgz"))
	.sort();
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: root,
	encoding: "utf8",
}).trim();
const entries = [];
for (const file of artifacts) {
	const bytes = await readFile(join(output, file));
	entries.push({
		file,
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
}
const manifest = {
	schema: "repoarena.release/v1",
	version: "1.0.0",
	commit,
	node: process.version,
	pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
	artifacts: entries,
};
await writeFile(
	join(output, "manifest.json"),
	`${JSON.stringify(manifest, null, "\t")}\n`,
);
await writeFile(
	join(output, "SHA256SUMS"),
	`${entries.map((item) => `${item.sha256}  ${item.file}`).join("\n")}\n`,
);
process.stdout.write(`RELEASE_DRY_RUN_OK ${output}\n`);
