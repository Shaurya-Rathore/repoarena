import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const run = (args) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (run(["status", "--porcelain"]))
	throw new Error("Release publication requires a clean working tree");
const version = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const tag =
	process.env.REPOARENA_RELEASE_TAG ??
	run(["describe", "--tags", "--exact-match"]);
if (tag !== `v${version}`)
	throw new Error(`Release tag ${tag} does not match package ${version}`);
if (!run(["branch", "--show-current"]).startsWith("release/"))
	throw new Error("Release publication requires a release/* branch");
process.stdout.write(`RELEASE_PUBLISH_CHECK_OK ${tag}\n`);
