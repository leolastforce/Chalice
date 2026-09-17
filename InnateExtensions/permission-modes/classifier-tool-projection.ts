/**
 * Per-tool classifier input projection (CC toAutoClassifierInput equivalent).
 */

import { redactForClassifier } from "./classifier-redact.ts"

const CONTENT_PREVIEW_CHARS = 500

/** Project tool input for classifier transcript lines. '' = no security-relevant input. */
export function toClassifierInput(
	toolName: string,
	input: Record<string, unknown>,
): unknown {
	switch (toolName) {
		case "bash": {
			const cmd = String(input.command ?? "").trim()
			return cmd || ""
		}
		case "read":
		case "grep":
		case "find":
		case "ls": {
			const path = String(input.path ?? input.file ?? "").trim()
			const pattern = String(input.pattern ?? "").trim()
			if (path) return path
			if (pattern) return pattern
			return ""
		}
		case "edit":
		case "write": {
			const path = String(input.path ?? "").trim()
			if (!path) return ""
			const raw = input.content ?? input.new_string ?? input.old_string
			const text =
				typeof raw === "string"
					? raw
					: raw != null
						? JSON.stringify(raw)
						: ""
			const preview = text
				? redactForClassifier(text.slice(0, CONTENT_PREVIEW_CHARS))
				: undefined
			return preview ? { path, preview } : { path }
		}
		default: {
			if (!input || Object.keys(input).length === 0) return ""
			return redactForClassifier(JSON.stringify(input), 2000)
		}
	}
}
