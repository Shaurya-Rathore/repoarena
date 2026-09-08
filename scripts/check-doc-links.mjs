import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const files = execFileSync("git", ["ls-files", "*.md"], {
	cwd: root,
	encoding: "utf8",
})
	.trim()
	.split("\n")
	.filter(Boolean);
const failures = [];
for (const file of files) {
	const text = await readFile(resolve(root, file), "utf8");
	for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
		let target = match[1].trim().replace(/^<|>$/g, "");
		if (!target || target.startsWith("#") || /^[a-z][a-z+.-]*:/i.test(target))
			continue;
		target = decodeURIComponent(target.split("#", 1)[0]);
		if (!target) continue;
		try {
			await access(resolve(root, dirname(file), target));
		} catch {
			failures.push(`${file}: ${match[1]}`);
		}
	}
}
if (failures.length)
	throw new Error(`Broken documentation links:\n${failures.join("\n")}`);
process.stdout.write(`DOC_LINKS_OK ${files.length} markdown files\n`);
