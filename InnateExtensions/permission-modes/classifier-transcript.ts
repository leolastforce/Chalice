/**
 * CC-style classifier transcript: user text + assistant tool calls only.
 * Assistant free-text is excluded to prevent prompt injection into the classifier.
 */

import { redactForClassifier } from "./classifier-redact.ts"
import { toClassifierInput } from "./classifier-tool-projection.ts"

export type TranscriptBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; name: string; input: unknown }

export type TranscriptEntry = {
	role: "user" | "assistant"
	content: TranscriptBlock[]
}

type PiMessageEntry = {
	type?: string
	message?: {
		role?: string
		content?: unknown
	}
}

function extractUserText(content: unknown): string[] {
	const texts: string[] = []
	if (typeof content === "string" && content.trim()) {
		texts.push(content.trim())
		return texts
	}
	if (!Array.isArray(content)) return texts
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") {
			const t = block.text.trim()
			if (t) texts.push(t)
		}
	}
	return texts
}

function extractAssistantToolCalls(content: unknown): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = []
	if (!Array.isArray(content)) return blocks
	for (const block of content) {
		if (block?.type === "toolCall" && typeof block.name === "string") {
			blocks.push({
				type: "tool_use",
				name: block.name,
				input: block.arguments ?? {},
			})
		}
		// CC uses tool_use; some paths may still emit tool_use in stored sessions
		if (block?.type === "tool_use" && typeof block.name === "string") {
			blocks.push({
				type: "tool_use",
				name: block.name,
				input: block.input ?? {},
			})
		}
	}
	return blocks
}

/** Build transcript from pi session branch entries (getBranch()). */
export function buildTranscriptEntriesFromBranch(
	branch: PiMessageEntry[],
): TranscriptEntry[] {
	const transcript: TranscriptEntry[] = []
	for (const entry of branch) {
		if (entry?.type !== "message") continue
		const msg = entry.message
		if (!msg?.role) continue

		if (msg.role === "user") {
			const texts = extractUserText(msg.content)
			if (texts.length === 0) continue
			transcript.push({
				role: "user",
				content: texts.map((text) => ({ type: "text", text })),
			})
			continue
		}

		if (msg.role === "assistant") {
			const toolBlocks = extractAssistantToolCalls(msg.content)
			if (toolBlocks.length === 0) continue
			transcript.push({ role: "assistant", content: toolBlocks })
		}
	}
	return transcript
}

function encodeToolValue(toolName: string, input: unknown): unknown {
	try {
		return toClassifierInput(toolName, (input ?? {}) as Record<string, unknown>)
	} catch {
		return input
	}
}

function toCompactBlock(
	block: TranscriptBlock,
	role: TranscriptEntry["role"],
	jsonl: boolean,
): string {
	if (block.type === "tool_use") {
		const encoded = encodeToolValue(
			block.name,
			block.input as Record<string, unknown>,
		)
		if (encoded === "") return ""
		if (jsonl) {
			return `${JSON.stringify({ [block.name]: encoded })}\n`
		}
		const s =
			typeof encoded === "string" ? encoded : JSON.stringify(encoded)
		return `${block.name} ${s}\n`
	}
	if (block.type === "text" && role === "user") {
		const text = redactForClassifier(block.text)
		return jsonl
			? `${JSON.stringify({ user: text })}\n`
			: `User: ${text}\n`
	}
	return ""
}

function toCompact(entry: TranscriptEntry, jsonl: boolean): string {
	return entry.content
		.map((b) => toCompactBlock(b, entry.role, jsonl))
		.join("")
}

export function formatActionForClassifier(
	toolName: string,
	toolInput: unknown,
): TranscriptEntry {
	return {
		role: "assistant",
		content: [{ type: "tool_use", name: toolName, input: toolInput }],
	}
}

export function buildTranscriptForClassifier(
	branch: PiMessageEntry[],
	jsonl = false,
	maxEntries = 40,
	maxChars = 12_000,
): string {
	const entries = buildTranscriptEntriesFromBranch(branch)
	let slice =
		entries.length > maxEntries ? entries.slice(-maxEntries) : entries
	let text = slice.map((e) => toCompact(e, jsonl)).join("")
	while (slice.length > 1 && text.length > maxChars) {
		slice = slice.slice(1)
		text = slice.map((e) => toCompact(e, jsonl)).join("")
	}
	return text
}

export function compactTranscriptEntry(
	entry: TranscriptEntry,
	jsonl = false,
): string {
	return toCompact(entry, jsonl)
}
