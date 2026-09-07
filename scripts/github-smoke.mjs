import { GitHubProvider } from "../packages/github-provider/dist/index.js";

if (process.env.REPOARENA_REAL_GITHUB_TESTS !== "1")
	throw new Error(
		"Set REPOARENA_REAL_GITHUB_TESTS=1 for the opt-in read-only smoke",
	);
for (const name of [
	"GITHUB_APP_ID",
	"GITHUB_APP_PRIVATE_KEY",
	"GITHUB_TEST_INSTALLATION_ID",
])
	if (!process.env[name]) throw new Error(`${name} is required`);
const provider = new GitHubProvider({
	appId: process.env.GITHUB_APP_ID,
	privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"),
});
const repositories = await provider.listInstallationRepositories(
	process.env.GITHUB_TEST_INSTALLATION_ID,
);
process.stdout.write(
	`${JSON.stringify({ repositories: repositories.length })}\n`,
);
