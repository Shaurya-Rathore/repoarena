import { readFile } from "node:fs/promises";
import { CloudService } from "../packages/cloud-core/dist/index.js";
import { createDatabase } from "../packages/cloud-db/dist/index.js";
import { GitHubIntegration } from "../packages/github-integration/dist/index.js";
import { GitHubProvider } from "../packages/github-provider/dist/index.js";

if (!process.env.DATABASE_URL) {
	const local = await readFile(
		new URL("../.env.local", import.meta.url),
		"utf8",
	);
	process.env.DATABASE_URL = local.match(/^DATABASE_URL=(.+)$/m)?.[1];
}
for (const name of [
	"GITHUB_APP_ID",
	"GITHUB_APP_PRIVATE_KEY",
	"GITHUB_WEBHOOK_SECRET",
])
	if (!process.env[name]) throw new Error(`${name} is required.`);

const database = createDatabase();
const provider = new GitHubProvider({
	appId: process.env.GITHUB_APP_ID,
	privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"),
});
const integration = new GitHubIntegration(
	database,
	new CloudService(database),
	provider,
	process.env.GITHUB_WEBHOOK_SECRET,
);
let stopping = false;
process.once("SIGINT", () => {
	stopping = true;
});
process.once("SIGTERM", () => {
	stopping = true;
});
try {
	do {
		const result = await integration.processQueued();
		if (process.env.REPOARENA_GITHUB_WEBHOOK_ONCE === "1") break;
		if (result.processed === 0 && result.failed === 0)
			await new Promise((resolve) => setTimeout(resolve, 1_000));
	} while (!stopping);
} finally {
	await database.close();
}
