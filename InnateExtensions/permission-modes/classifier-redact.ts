/** Redact likely secrets before sending to classifier provider. */

export function redactForClassifier(text: string, limit = 4000): string {
	const redacted = text
		.replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, "sk-[REDACTED]")
		.replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, "Bearer [REDACTED]")
		.replace(
			/"((?:api[_-]?key|token|password))"\s*:\s*"[^"]*"/gi,
			'"$1":"[REDACTED]"',
		)
		.replace(
			/"((?:api[_-]?key|token|password))"\s*:\s*(?!")[^,\s}\]]+/gi,
			'"$1":"[REDACTED]"',
		)
		.replace(/\b(api[_-]?key|token|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
	if (!Number.isFinite(limit) || redacted.length <= limit) return redacted
	const tailLen = Math.min(1000, Math.floor(limit / 3))
	const headLen = limit - tailLen - 15
	return (
		redacted.slice(0, headLen) +
		"\n...[truncated]...\n" +
		redacted.slice(-tailLen)
	)
}
