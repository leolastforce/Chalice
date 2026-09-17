import { describe, expect, it } from "vitest"
import { pathMatchesRulePattern } from "./path-permission-match.ts"

describe("path-permission-match", () => {
	const cwd = "/home/user/project"

	it("matches exact relative path", () => {
		expect(pathMatchesRulePattern(".env", "./.env", cwd)).toBe(true)
	})

	it("matches glob patterns", () => {
		expect(pathMatchesRulePattern(".git/config", "./.git/**", cwd)).toBe(
			true,
		)
	})

	it("matches home path pattern", () => {
		expect(pathMatchesRulePattern("~/.zshrc", "~/.zshrc", cwd)).toBe(true)
	})
})
