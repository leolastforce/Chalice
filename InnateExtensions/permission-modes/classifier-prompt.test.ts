import { describe, expect, it } from "vitest"
import {
	buildClassifierSystemPrompt,
	clearClassifierPromptCache,
	getDefaultAutoModeRules,
} from "./classifier-prompt.ts"

describe("buildClassifierSystemPrompt", () => {
	it("includes CC base categories and external permissions template", () => {
		const prompt = buildClassifierSystemPrompt()
		expect(prompt).toContain("BLOCK — Always require confirmation")
		expect(prompt).toContain("Allow Rules")
		expect(prompt).toContain("npm install")
		expect(prompt).toContain("shouldBlock")
		expect(prompt).not.toContain("classify_result tool")
	})

	it("replaces default allow rules when user provides autoMode.allow", () => {
		const prompt = buildClassifierSystemPrompt({
			allow: ["Custom allow rule for tests"],
		})
		expect(prompt).toContain("Custom allow rule for tests")
		expect(prompt).not.toContain("Running read-only shell commands")
	})

	it("getDefaultAutoModeRules extracts bullets from template", () => {
		clearClassifierPromptCache()
		const defaults = getDefaultAutoModeRules()
		expect(defaults.allow?.length).toBeGreaterThan(5)
		expect(defaults.soft_deny?.length).toBeGreaterThan(5)
		expect(defaults.environment?.length).toBeGreaterThan(0)
	})
})
