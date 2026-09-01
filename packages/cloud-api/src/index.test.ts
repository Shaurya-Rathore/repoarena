import { expect, it } from "vitest";
import { cloudApiContract, GitHubOAuthProvider } from "./index.js";
it("builds a state-bound GitHub OAuth authorization URL", () => {
	const provider = new GitHubOAuthProvider(
		"client",
		"secret",
		"https://app.example/callback",
	);
	const url = new URL(provider.authorizationUrl("state"));
	expect(url.origin).toBe("https://github.com");
	expect(url.searchParams.get("state")).toBe("state");
	expect(url.searchParams.get("client_secret")).toBeNull();
});

it("publishes the versioned cloud API contract", () => {
	expect(cloudApiContract.openapi).toBe("3.1.0");
	expect(cloudApiContract.paths).toHaveProperty("/api/v1/runner/jobs/claim");
});
