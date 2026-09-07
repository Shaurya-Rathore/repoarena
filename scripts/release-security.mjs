import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const tracked = execFileSync("git", ["ls-files"], {
	cwd: root,
	encoding: "utf8",
})
	.trim()
	.split("\n");
const forbidden = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
	/(?:sk_live_|rk_live_)[A-Za-z0-9]{12,}/,
	/gh[opsu]_[A-Za-z0-9]{20,}/,
];
for (const file of tracked) {
	if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
	const data = await readFile(join(root, file)).catch(() => null);
	if (!data || data.includes(0)) continue;
	const text = data.toString("utf8");
	if (forbidden.some((pattern) => pattern.test(text)))
		throw new Error(`Potential committed secret in ${file}`);
}
for (const file of await readdir(join(root, "release-artifacts")).catch(
	() => [],
)) {
	const bytes = await readFile(join(root, "release-artifacts", file));
	for (const sentinel of [
		"STRIPE_SECRET_SENTINEL",
		"PRIVATE_EVALUATOR_SENTINEL",
		"HOSTED_PROVIDER_SECRET_SENTINEL",
	]) {
		if (bytes.includes(Buffer.from(sentinel)))
			throw new Error(`Release artifact ${file} contains ${sentinel}`);
	}
}
process.stdout.write("RELEASE_SECURITY_OK\n");
