import { readFile } from "node:fs/promises";
import {
	createCloudApi,
	GitHubOAuthProvider,
} from "../packages/cloud-api/dist/index.js";
import { createDatabase } from "../packages/cloud-db/dist/index.js";
import {
	FileObjectStorage,
	S3ObjectStorage,
} from "../packages/object-storage/dist/index.js";

if (!process.env.DATABASE_URL) {
	const local = await readFile(
		new URL("../.env.local", import.meta.url),
		"utf8",
	);
	process.env.DATABASE_URL = local.match(/^DATABASE_URL=(.+)$/m)?.[1];
}
const database = createDatabase();
const origin = process.env.REPOARENA_CLOUD_ORIGIN ?? "http://127.0.0.1:8080";
const storage = process.env.S3_BUCKET
	? new S3ObjectStorage(process.env.S3_BUCKET, {
			region: process.env.S3_REGION ?? "us-east-1",
			endpoint: process.env.S3_ENDPOINT,
		})
	: new FileObjectStorage(
			process.env.REPOARENA_OBJECT_ROOT ?? ".repoarena/cloud-objects",
		);
const oauth =
	process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
		? new GitHubOAuthProvider(
				process.env.GITHUB_CLIENT_ID,
				process.env.GITHUB_CLIENT_SECRET,
				`${origin}/auth/callback`,
			)
		: undefined;
const api = createCloudApi({
	database,
	storage,
	publicOrigin: origin,
	...(oauth ? { oauth } : {}),
});
const address = await api.start(
	"127.0.0.1",
	Number(new URL(origin).port || 8080),
);
process.stdout.write(`RepoArena cloud API listening at ${address.url}\n`);
const close = async () => {
	await api.close();
	await database.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
