import { z } from "zod";

const errorSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		request_id: z.string(),
	}),
});
export class CloudApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly requestId: string,
		readonly status: number,
	) {
		super(message);
	}
}
export class CloudApiClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token?: string,
	) {}
	async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await fetch(new URL(path, this.baseUrl), {
			...init,
			headers: {
				accept: "application/json",
				...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
				...init.headers,
			},
		});
		const body: unknown = await response.json();
		if (!response.ok) {
			const parsed = errorSchema.safeParse(body);
			if (parsed.success)
				throw new CloudApiError(
					parsed.data.error.code,
					parsed.data.error.message,
					parsed.data.error.request_id,
					response.status,
				);
			throw new CloudApiError(
				"INTERNAL",
				"Cloud API returned an invalid error response.",
				response.headers.get("x-request-id") ?? "unknown",
				response.status,
			);
		}
		return (body as { data: T }).data;
	}
}
