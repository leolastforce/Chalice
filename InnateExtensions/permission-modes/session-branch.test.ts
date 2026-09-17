import { describe, expect, it } from "vitest"

import {
	readBranchEntries,
	readBranchMessages,
	readCustomEntryData,
	readGitBranch,
	readSessionId,
	type BranchEntry,
} from "./session-branch.ts"

// Real SessionEntry shapes from pi 0.80+ typings (plan B1 / C2): messages are
// wrapped as {type:"message", message:{role:"user"|"assistant"|"toolResult"}}.
function msg(
	role: "user" | "assistant" | "toolResult",
	content: unknown,
	extra: Record<string, unknown> = {},
): BranchEntry {
	return { type: "message", id: `e-${role}`, message: { role, content, ...extra } }
}

const branch: BranchEntry[] = [
	msg("user", "list the files"),
	{
		type: "message",
		id: "e-a1",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
		},
	},
	msg("toolResult", [{ type: "text", text: "file_a file_b" }], {
		toolName: "bash",
		toolCallId: "c1",
	}),
	{ type: "custom", customType: "modes", data: { currentMode: "auto" } },
	{ type: "thinkingLevelChange", thinkingLevel: "high" },
]

const sessionManager = {
	getBranch: () => branch,
	getEntries: () => [
		{ type: "custom", customType: "modes", data: { currentMode: "ask" } },
		{ type: "custom", customType: "modes", data: { currentMode: "auto" } },
		{ type: "custom", customType: "other", data: { x: 1 } },
	],
	getGitBranch: () => "main",
	getSessionId: () => "sess-42",
}

describe("readBranchEntries", () => {
	it("returns the raw wrapped entries as-is", () => {
		expect(readBranchEntries(sessionManager)).toHaveLength(5)
		expect(readBranchEntries(sessionManager)[3]).toMatchObject({
			type: "custom",
			customType: "modes",
		})
	})

	it("returns [] for missing sessionManager, missing getBranch, or throws", () => {
		expect(readBranchEntries(undefined)).toEqual([])
		expect(readBranchEntries({})).toEqual([])
		expect(readBranchEntries({ getBranch: () => { throw new Error("stale") } })).toEqual([])
		expect(readBranchEntries({ getBranch: () => null })).toEqual([])
	})
})

describe("readBranchMessages", () => {
	it("unwraps message entries in order and skips non-message entries", () => {
		const messages = readBranchMessages(sessionManager)
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		])
		expect(messages[1]?.usage).toMatchObject({ input: 10 })
		expect(messages[2]?.toolName).toBe("bash")
	})

	it("drops malformed message entries instead of throwing", () => {
		const sm = {
			getBranch: () => [
				{ type: "message", message: { role: "toolResult", content: "x" } },
				{ type: "message", message: null },
				{ type: "message", message: { role: "weird" } },
			],
		}
		expect(readBranchMessages(sm).map((m) => m.role)).toEqual(["toolResult"])
	})
})

describe("readCustomEntryData", () => {
	it("returns payloads for the customType, oldest first", () => {
		const data = readCustomEntryData(sessionManager, "modes")
		expect(data).toEqual([{ currentMode: "ask" }, { currentMode: "auto" }])
		expect(readCustomEntryData(sessionManager, "missing")).toEqual([])
	})

	it("returns [] when getEntries is unavailable or throws", () => {
		expect(readCustomEntryData({}, "modes")).toEqual([])
		expect(
			readCustomEntryData({ getEntries: () => { throw new Error("x") } }, "modes"),
		).toEqual([])
	})
})

describe("readGitBranch / readSessionId", () => {
	it("returns string values or undefined fallbacks", () => {
		expect(readGitBranch(sessionManager)).toBe("main")
		expect(readGitBranch({ getGitBranch: () => 7 })).toBeUndefined()
		expect(readSessionId(sessionManager)).toBe("sess-42")
		expect(readSessionId({})).toBeUndefined()
	})
})
