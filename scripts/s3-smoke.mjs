import { createHash, randomUUID } from "node:crypto";
import {
	S3ObjectStorage,
	objectKey,
} from "../packages/object-storage/dist/index.js";

if (process.env.REPOARENA_REAL_S3_TESTS !== "1")
	throw new Error("Set REPOARENA_REAL_S3_TESTS=1 for the opt-in bounded smoke");
for (const name of ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY"])
	if (!process.env[name]) throw new Error(`${name} is required`);
const storage = new S3ObjectStorage(process.env.S3_BUCKET, {
	region: process.env.S3_REGION,
	endpoint: process.env.S3_ENDPOINT,
	credentials: {
		accessKeyId: process.env.S3_ACCESS_KEY,
		secretAccessKey: process.env.S3_SECRET_KEY,
	},
});
const key = objectKey(randomUUID());
const body = Buffer.from("repoarena-s3-smoke");
const checksum = createHash("sha256").update(body).digest("base64");
try {
	await storage.put(key, body, { contentType: "text/plain", checksum });
	const restored = await storage.get(key);
	if (!Buffer.from(restored).equals(body))
		throw new Error("S3 smoke content mismatch");
	await storage.signedReadUrl(key, 60);
	process.stdout.write("S3_SMOKE_OK\n");
} finally {
	await storage.delete(key);
}
