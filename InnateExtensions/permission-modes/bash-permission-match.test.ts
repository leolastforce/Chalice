import { describe, expect, it } from "vitest"
import {
	bashCommandMatchesRuleContent,
	suggestBashAllowRule,
} from "./bash-permission-match.ts"

describe("bash-permission-match", () => {
	it("allow matches single-segment prefix rule", () => {
		expect(
			bashCommandMatchesRuleContent("npm run test", "npm run:*", "allow"),
		).toBe(true)
	})

	it("allow does not match compound commands", () => {
		expect(
			bashCommandMatchesRuleContent(
				"git status && rm -rf /",
				"git:*",
				"allow",
			),
		).toBe(false)
	})

	it("deny matches any compound segment", () => {
		expect(
			bashCommandMatchesRuleContent(
				"git status && rm -rf /",
				"rm:*",
				"deny",
			),
		).toBe(true)
	})

	it("suggests prefix rule for bash", () => {
		expect(suggestBashAllowRule("npm run test")).toBe("Bash(npm:*)")
	})
})
