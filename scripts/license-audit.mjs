import { execFileSync } from "node:child_process";

const output = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
	encoding: "utf8",
	maxBuffer: 20 * 1024 * 1024,
});
const inventory = JSON.parse(output);
const denied = new Set(["AGPL-1.0", "AGPL-3.0", "SSPL-1.0", "BUSL-1.1"]);
const unknown = [];
for (const [license, packages] of Object.entries(inventory)) {
	if (denied.has(license))
		throw new Error(`Restricted dependency license: ${license}`);
	if (/unknown|unlicensed/i.test(license))
		unknown.push(...packages.map((item) => item.name));
}
if (unknown.length)
	throw new Error(`Unknown dependency licenses: ${unknown.join(", ")}`);
process.stdout.write(
	`LICENSE_AUDIT_OK ${Object.keys(inventory).length} license expressions\n`,
);
