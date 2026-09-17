import { describe, expect, it } from "vitest"
import {
	hasWildcards,
	matchWildcardPattern,
	parsePermissionRule,
	matchShellRule,
} from "./shell-rule-matching.ts"

describe("shell-rule-matching", () => {
	it("parses legacy prefix syntax", () => {
		expect(parsePermissionRule("npm run:*")).toEqual({
			type: "prefix",
			prefix: "npm run",
		})
	})

	it("parses wildcard syntax", () => {
		expect(parsePermissionRule("npm run *")).toEqual({
			type: "wildcard",
			pattern: "npm run *",
		})
	})

	it("matches wildcard in middle", () => {
		expect(matchWildcardPattern("* install", "npm install")).toBe(true)
		expect(matchWildcardPattern("* install", "yarn install")).toBe(true)
	})

	it("matches prefix with word boundary", () => {
		const rule = parsePermissionRule("git:*")
		expect(matchShellRule(rule, "git status", "prefix", true)).toBe(true)
		expect(matchShellRule(rule, "github", "prefix", true)).toBe(false)
	})
})
