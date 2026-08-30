import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.cwd(), ".agents", "skills");
const invalid = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const file = join(root, entry.name, "SKILL.md");
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch {
		invalid.push(`${entry.name}: missing SKILL.md`);
		continue;
	}
	const match = text.match(
		/^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/s,
	);
	if (!match)
		invalid.push(
			`${entry.name}: frontmatter must contain exactly name and description`,
		);
	else if (match[1] !== entry.name)
		invalid.push(`${entry.name}: name must match folder`);
	else if (/\b(?:todo|fixme|placeholder|not implemented)\b/i.test(text))
		invalid.push(`${entry.name}: unfinished marker`);
}
if (invalid.length) {
	process.stderr.write(`${invalid.join("\n")}\n`);
	process.exitCode = 1;
} else process.stdout.write("Repository skills valid.\n");
