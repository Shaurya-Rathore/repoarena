import { execFileSync } from "node:child_process";

if (process.env.REPOARENA_REAL_AGENT_TESTS !== "1")
	throw new Error(
		"Set REPOARENA_REAL_AGENT_TESTS=1 for the opt-in paid-agent smoke",
	);
if (!process.env.REPOARENA_TEST_AGENT)
	throw new Error("REPOARENA_TEST_AGENT is required");
if (process.env.REPOARENA_AGENT_SMOKE_ACKNOWLEDGE_COST !== "yes")
	throw new Error("Set REPOARENA_AGENT_SMOKE_ACKNOWLEDGE_COST=yes");
execFileSync(
	process.execPath,
	[
		new URL("../packages/cli/dist/index.js", import.meta.url).pathname,
		"run",
		"--agent",
		process.env.REPOARENA_TEST_AGENT,
		"--runs-per-task",
		"1",
		"--parallel",
		"1",
		"--report",
		"terminal",
	],
	{ cwd: process.cwd(), stdio: "inherit", env: process.env },
);
