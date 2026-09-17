import { describe, expect, it } from "vitest"

import {
	formatDangerousRuleDisplay,
	isDangerousBashPermission,
	restoreDangerousPermissionRules,
	stripDangerousPermissionRules,
} from "./dangerous-permissions.ts"
import { permissionRuleValueFromString } from "./permission-rule-parser.ts"
import type { PermissionRule } from "./permissions.ts"

function allowRule(
	ruleString: string,
	source: PermissionRule["source"] = "project",
): PermissionRule {
	return {
		source,
		behavior: "allow",
		ruleValue: permissionRuleValueFromString(ruleString),
	}
}

describe("dangerous-permissions", () => {
	it("flags Bash(*) and interpreter prefixes as dangerous", () => {
		expect(isDangerousBashPermission("Bash", undefined)).toBe(true)
		expect(isDangerousBashPermission("Bash", "*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "python:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "npm run:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "curl:*")).toBe(true)
	})

	it("does not flag specific safe-ish allow patterns", () => {
		// Narrow script-scoped rules survive; only broad verb/bare forms are stripped.
		expect(isDangerousBashPermission("Bash", "npm run test *")).toBe(false)
		expect(isDangerousBashPermission("Bash", "npm install lodash:*")).toBe(false)
	})

	// Adjudication ② (2026-09-12): package managers with lifecycle-script
	// execution are dangerous as broad rules — see docs/bash-risk-adjudication-2026-09-12.md.
	it("flags broad package-manager allow rules as dangerous", () => {
		expect(isDangerousBashPermission("Bash", "npm:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "npm install *")).toBe(true)
		expect(isDangerousBashPermission("Bash", "npm install:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "npm ci:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "pnpm add:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "pnpm dlx:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "yarn add:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "bun add:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "bunx:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "pip install:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "pip3 install:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "cargo install:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "cargo run:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "uv run:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "poetry install:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "gem install:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "composer require:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "go run:*")).toBe(true)
	})

	it("strips dangerous allow rules on auto entry and restores on exit", () => {
		const rules = [
			allowRule("Bash(npm install *)"),
			allowRule("Bash(python:*)"),
			allowRule("Bash(*)"),
		]
		const stripped = stripDangerousPermissionRules(rules)
		expect(stripped.active).toHaveLength(0)
		expect(stripped.stashed).toHaveLength(3)
		expect(formatDangerousRuleDisplay(stripped.stashed[0]!.ruleValue)).toBe(
			"Bash(npm install *)",
		)
		const restored = restoreDangerousPermissionRules(
			stripped.active,
			stripped.stashed,
		)
		expect(restored).toHaveLength(3)
	})
})
