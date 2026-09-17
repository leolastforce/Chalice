import { describe, expect, it } from "vitest"
import {
	evaluateToolPermission,
	mergePermissionRules,
	rulesFromPermissionsConfig,
	suggestAllowRuleForToolCall,
} from "./permissions.ts"

describe("permissions evaluate", () => {
	const cwd = "/home/user/project"

	it("deny beats allow", () => {
		const rules = mergePermissionRules(
			rulesFromPermissionsConfig(
				{ allow: ["Bash(git *)"], deny: ["Bash(rm *)"] },
				"global",
			),
		)
		const verdict = evaluateToolPermission(
			"bash",
			{ command: "rm file" },
			cwd,
			rules,
		)
		expect(verdict.behavior).toBe("deny")
	})

	it("allow skips passthrough for matching bash", () => {
		const rules = rulesFromPermissionsConfig(
			{ allow: ["Bash(npm run:*)"] },
			"project",
		)
		const verdict = evaluateToolPermission(
			"bash",
			{ command: "npm run test" },
			cwd,
			rules,
		)
		expect(verdict.behavior).toBe("allow")
	})

	it("ask rule triggers ask verdict", () => {
		const rules = rulesFromPermissionsConfig(
			{ ask: ["Bash(npm install *)"] },
			"global",
		)
		const verdict = evaluateToolPermission(
			"bash",
			{ command: "npm install foo" },
			cwd,
			rules,
		)
		expect(verdict.behavior).toBe("ask")
	})

	it("suggests allow rule for tool call", () => {
		expect(
			suggestAllowRuleForToolCall(
				"bash",
				{ command: "npm test" },
				cwd,
			),
		).toBe("Bash(npm:*)")
	})
})
