import { expect, it } from "vitest";
import { DockerSandboxProvider } from "./index.js";
it("builds restrictive Docker arguments", () => {
	const a = new DockerSandboxProvider("/safe/work", "node:24", {
		cpu: 1,
		memory_mb: 512,
		pids: 64,
	}).buildArgs(
		{
			argv: ["node", "x.mjs"],
			cwd: "/safe/work",
			env: { REPOARENA_NETWORK_POLICY: "DISABLED", TOKEN: "secret" },
			timeout_seconds: 1,
		},
		"ra-test",
	);
	expect(a).toContain("none");
	expect(a).toContain("--cap-drop");
	expect(a).not.toContain("--privileged");
	expect(a.join(" ")).not.toContain("/var/run/docker.sock");
	expect(a.join(" ")).not.toContain("secret");
	expect(a).toContain("TOKEN");
});
