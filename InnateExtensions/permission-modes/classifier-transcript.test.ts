import { describe, expect, it } from "vitest"
import {
	buildTranscriptEntriesFromBranch,
	buildTranscriptForClassifier,
	compactTranscriptEntry,
	formatActionForClassifier,
} from "./classifier-transcript.ts"

describe("classifier-transcript", () => {
	it("includes user text and assistant toolCall history only", () => {
		const transcript = buildTranscriptForClassifier([
			{
				type: "message",
				message: { role: "user", content: "run tests" },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Sure, running tests now." },
						{
							type: "toolCall",
							id: "t1",
							name: "bash",
							arguments: { command: "npm test" },
						},
					],
				},
			},
		])
		expect(transcript).toContain("User: run tests")
		expect(transcript).toContain("bash npm test")
		expect(transcript).not.toContain("Sure, running")
	})

	it("supports JSONL transcript format", () => {
		const transcript = buildTranscriptForClassifier(
			[
				{
					type: "message",
					message: { role: "user", content: "hi" },
				},
			],
			true,
		)
		expect(transcript).toContain('{"user":"hi"}')
	})

	it("formatActionForClassifier compacts pending tool", () => {
		const compact = compactTranscriptEntry(
			formatActionForClassifier("bash", { command: "node -v" }),
		)
		expect(compact).toBe("bash node -v\n")
	})

	it("buildTranscriptEntriesFromBranch skips non-message entries", () => {
		const entries = buildTranscriptEntriesFromBranch([
			{ type: "label", message: { role: "user", content: "x" } } as any,
			{
				type: "message",
				message: { role: "user", content: "keep" },
			},
		])
		expect(entries).toHaveLength(1)
		expect(entries[0]?.content[0]).toEqual({ type: "text", text: "keep" })
	})
})
