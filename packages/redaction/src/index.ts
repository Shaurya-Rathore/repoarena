export class SecretRedactor {
	constructor(private readonly secrets: string[]) {
		this.secrets = secrets
			.filter((value) => value.length >= 8)
			.sort((a, b) => b.length - a.length);
	}
	redact(text: string): string {
		let value = text;
		for (const secret of this.secrets)
			value = value.split(secret).join("[REDACTED]");
		return value.replace(
			/\b(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
			"[REDACTED]",
		);
	}
}
