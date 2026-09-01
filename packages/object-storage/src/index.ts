import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
	type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type ObjectMetadata = Readonly<{
	key: string;
	size: number;
	contentType: string | null;
	checksum: string | null;
}>;
export interface ObjectStorage {
	put(
		key: string,
		body: Uint8Array,
		metadata?: { contentType?: string; checksum?: string },
	): Promise<ObjectMetadata>;
	get(key: string): Promise<Uint8Array>;
	head(key: string): Promise<ObjectMetadata | null>;
	delete(key: string): Promise<void>;
	signedReadUrl(key: string, expiresSeconds: number): Promise<string>;
}

const keyPattern = /^org\/[0-9a-f-]{36}\/objects\/[0-9a-f-]{36}$/;
export const objectKey = (organizationId: string) =>
	`org/${organizationId}/objects/${randomUUID()}`;
export const validateObjectKey = (key: string) => {
	if (!keyPattern.test(key))
		throw new RangeError("Object key must be server-generated");
	return key;
};

export class FileObjectStorage implements ObjectStorage {
	constructor(
		private readonly root: string,
		private readonly now: () => number = Date.now,
	) {}
	private path(key: string) {
		validateObjectKey(key);
		const root = resolve(this.root);
		const path = resolve(root, key);
		if (!path.startsWith(`${root}${sep}`))
			throw new RangeError("Object key escapes storage root");
		return path;
	}
	async put(
		key: string,
		body: Uint8Array,
		metadata: { contentType?: string; checksum?: string } = {},
	) {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, body, { mode: 0o600 });
		await writeFile(
			`${path}.metadata.json`,
			JSON.stringify({
				contentType: metadata.contentType ?? null,
				checksum: metadata.checksum ?? null,
			}),
			{ mode: 0o600 },
		);
		return {
			key,
			size: body.byteLength,
			contentType: metadata.contentType ?? null,
			checksum: metadata.checksum ?? null,
		};
	}
	get(key: string) {
		return readFile(this.path(key));
	}
	async head(key: string): Promise<ObjectMetadata | null> {
		const path = this.path(key);
		try {
			const info = await stat(path);
			const metadata = JSON.parse(
				await readFile(`${path}.metadata.json`, "utf8"),
			) as { contentType: string | null; checksum: string | null };
			return { key, size: info.size, ...metadata };
		} catch {
			return null;
		}
	}
	async delete(key: string) {
		const path = this.path(key);
		await rm(path, { force: true });
		await rm(`${path}.metadata.json`, { force: true });
	}
	async signedReadUrl(key: string, expiresSeconds: number) {
		validateObjectKey(key);
		if (
			!Number.isInteger(expiresSeconds) ||
			expiresSeconds < 1 ||
			expiresSeconds > 3600
		)
			throw new RangeError("Signed URL lifetime is invalid");
		return `file://${encodeURIComponent(key)}?expires=${this.now() + expiresSeconds * 1000}`;
	}
}

export class S3ObjectStorage implements ObjectStorage {
	private readonly client: S3Client;
	constructor(
		private readonly bucket: string,
		configuration: S3ClientConfig,
	) {
		this.client = new S3Client(configuration);
	}
	async put(
		key: string,
		body: Uint8Array,
		metadata: { contentType?: string; checksum?: string } = {},
	) {
		validateObjectKey(key);
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: body,
				ContentType: metadata.contentType,
				ChecksumSHA256: metadata.checksum,
			}),
		);
		return {
			key,
			size: body.byteLength,
			contentType: metadata.contentType ?? null,
			checksum: metadata.checksum ?? null,
		};
	}
	async get(key: string) {
		validateObjectKey(key);
		const response = await this.client.send(
			new GetObjectCommand({ Bucket: this.bucket, Key: key }),
		);
		if (!response.Body) throw new Error("Object body is unavailable");
		return response.Body.transformToByteArray();
	}
	async head(key: string): Promise<ObjectMetadata | null> {
		validateObjectKey(key);
		try {
			const response = await this.client.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
			);
			return {
				key,
				size: response.ContentLength ?? 0,
				contentType: response.ContentType ?? null,
				checksum: response.ChecksumSHA256 ?? null,
			};
		} catch (error) {
			if (
				(error as { $metadata?: { httpStatusCode?: number } }).$metadata
					?.httpStatusCode === 404
			)
				return null;
			throw error;
		}
	}
	async delete(key: string) {
		validateObjectKey(key);
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
		);
	}
	async signedReadUrl(key: string, expiresSeconds: number) {
		validateObjectKey(key);
		if (
			!Number.isInteger(expiresSeconds) ||
			expiresSeconds < 1 ||
			expiresSeconds > 3600
		)
			throw new RangeError("Signed URL lifetime is invalid");
		return getSignedUrl(
			this.client,
			new GetObjectCommand({ Bucket: this.bucket, Key: key }),
			{ expiresIn: expiresSeconds },
		);
	}
}
