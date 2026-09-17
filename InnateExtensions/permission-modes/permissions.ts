/**
 * Permission rule evaluation (CC permissions.ts subset).
 * Order: deny → ask → allow → passthrough.
 */

import {
	bashCommandMatchesRuleContent,
	suggestBashAllowRule,
} from "./bash-permission-match.ts"
import {
	pathToolMatchesRuleContent,
	suggestPathAllowRule,
} from "./path-permission-match.ts"
import {
	permissionRuleValueFromString,
	permissionRuleValueToString,
	type PermissionRuleValue,
} from "./permission-rule-parser.ts"

export type PermissionBehavior = "allow" | "deny" | "ask"

export type PermissionRuleSource = "global" | "project" | "local"

export interface PermissionRule {
	source: PermissionRuleSource
	behavior: PermissionBehavior
	ruleValue: PermissionRuleValue
}

export type PermissionVerdict =
	| { behavior: "deny"; rule: string; source: PermissionRuleSource }
	| { behavior: "ask"; rule: string; source: PermissionRuleSource }
	| { behavior: "allow"; rule: string; source: PermissionRuleSource }
	| { behavior: "passthrough" }

export interface PermissionsConfig {
	allow?: string[]
	deny?: string[]
	ask?: string[]
}

const PI_TO_CC_TOOL: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	grep: "Read",
	find: "Read",
	ls: "Read",
	edit: "Edit",
	write: "Write",
}

export function mapPiToolToCcTool(toolName: string): string | null {
	return PI_TO_CC_TOOL[toolName] ?? null
}

export function rulesFromPermissionsConfig(
	config: PermissionsConfig,
	source: PermissionRuleSource,
): PermissionRule[] {
	const rules: PermissionRule[] = []
	for (const behavior of ["deny", "ask", "allow"] as PermissionBehavior[]) {
		const list = config[behavior]
		if (!list) continue
		for (const ruleString of list) {
			rules.push({
				source,
				behavior,
				ruleValue: permissionRuleValueFromString(ruleString),
			})
		}
	}
	return rules
}

export function mergePermissionRules(
	...ruleSets: PermissionRule[][]
): PermissionRule[] {
	const seen = new Set<string>()
	const merged: PermissionRule[] = []
	for (const set of ruleSets) {
		for (const rule of set) {
			const key = `${rule.behavior}:${permissionRuleValueToString(rule.ruleValue)}`
			if (seen.has(key)) continue
			seen.add(key)
			merged.push(rule)
		}
	}
	return merged
}

function ruleMatchesToolCall(
	rule: PermissionRule,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): boolean {
	const ccTool = mapPiToolToCcTool(toolName)
	if (!ccTool) return false
	if (rule.ruleValue.toolName !== ccTool) return false

	if (ccTool === "Bash") {
		const cmd = String(input.command ?? "")
		return bashCommandMatchesRuleContent(
			cmd,
			rule.ruleValue.ruleContent,
			rule.behavior,
		)
	}

	const pathStr = String(input.path ?? "")
	if (!pathStr && rule.ruleValue.ruleContent !== undefined) {
		return false
	}

	if (ccTool === "Read") {
		return pathToolMatchesRuleContent(
			"Read",
			pathStr,
			rule.ruleValue.ruleContent,
			cwd,
		)
	}
	if (ccTool === "Edit") {
		return pathToolMatchesRuleContent(
			"Edit",
			pathStr,
			rule.ruleValue.ruleContent,
			cwd,
		)
	}
	if (ccTool === "Write") {
		return pathToolMatchesRuleContent(
			"Write",
			pathStr,
			rule.ruleValue.ruleContent,
			cwd,
		)
	}

	return false
}

export function evaluateToolPermission(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	rules: PermissionRule[],
): PermissionVerdict {
	const ccTool = mapPiToolToCcTool(toolName)
	if (!ccTool) {
		return { behavior: "passthrough" }
	}

	for (const behavior of ["deny", "ask", "allow"] as PermissionBehavior[]) {
		for (const rule of rules) {
			if (rule.behavior !== behavior) continue
			if (!ruleMatchesToolCall(rule, toolName, input, cwd)) continue
			return {
				behavior,
				rule: permissionRuleValueToString(rule.ruleValue),
				source: rule.source,
			}
		}
	}

	return { behavior: "passthrough" }
}

export function suggestAllowRuleForToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): string {
	const ccTool = mapPiToolToCcTool(toolName)
	if (ccTool === "Bash") {
		return suggestBashAllowRule(String(input.command ?? ""))
	}
	const pathStr = String(input.path ?? "")
	if (ccTool === "Read") return suggestPathAllowRule("Read", pathStr, cwd)
	if (ccTool === "Edit") return suggestPathAllowRule("Edit", pathStr, cwd)
	if (ccTool === "Write") return suggestPathAllowRule("Write", pathStr, cwd)
	return ccTool ?? toolName
}

export function formatMergedRulesForDisplay(rules: PermissionRule[]): string {
	const lines: string[] = []
	for (const behavior of ["deny", "ask", "allow"] as PermissionBehavior[]) {
		const subset = rules.filter((r) => r.behavior === behavior)
		if (!subset.length) continue
		lines.push(`${behavior}:`)
		for (const r of subset) {
			lines.push(
				`  [${r.source}] ${permissionRuleValueToString(r.ruleValue)}`,
			)
		}
	}
	return lines.length ? lines.join("\n") : "(no permission rules configured)"
}
