import { describe, expect, it } from "vitest"
import {
	escapeRuleContent,
	permissionRuleValueFromString,
	permissionRuleValueToString,
	unescapeRuleContent,
} from "./permission-rule-parser.ts"

describe("permission-rule-parser", () => {
	it("parses bare tool name", () => {
		expect(permissionRuleValueFromString("Bash")).toEqual({
			toolName: "Bash",
		})
	})

	it("parses tool with content", () => {
		expect(permissionRuleValueFromString("Bash(npm run test)")).toEqual({
			toolName: "Bash",
			ruleContent: "npm run test",
		})
	})

	it("unescapes parentheses in content", () => {
		const raw = "Bash(python -c \"print\\(1\\)\")"
		expect(permissionRuleValueFromString(raw).ruleContent).toBe(
			'python -c "print(1)"',
		)
	})

	it("round-trips through serialize", () => {
		const rule = "Bash(npm run test *)"
		const value = permissionRuleValueFromString(rule)
		expect(permissionRuleValueToString(value)).toBe(rule)
	})

	it("escapes and unescapes content", () => {
		const content = 'echo "test\\nvalue"'
		const escaped = escapeRuleContent(content)
		expect(unescapeRuleContent(escaped)).toBe(content)
	})
})
