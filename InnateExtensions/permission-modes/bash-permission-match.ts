/**
 * Bash permission rule matching (CC bashPermissions.ts subset).
 */

import { splitShellSegments } from "./utils.ts"
import {
	matchShellRule,
	parsePermissionRule,
	type ShellPermissionRule,
} from "./shell-rule-matching.ts"

const SAFE_WRAPPER_PREFIXES = [
	/^timeout(?:\s+\d+[smhd]?)?\s+/i,
	/^time\s+-p\s+/i,
	/^nice\s+-n\s+\d+\s+/i,
	/^nohup\s+/i,
]

const SAFE_ENV_VARS = new Set([
	"NODE_ENV",
	"RUST_BACKTRACE",
	"RUST_LOG",
	"PYTHONUNBUFFERED",
	"LANG",
	"LC_ALL",
	"TERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"TZ",
])

const ENV_VAR_PATTERN =
	/^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\'"])*[ \t]+/

export function stripOutputRedirections(command: string): string {
	return command.replace(/\s*(?:>>?|[0-9]+>>?)\s*[^\s;&|]+/g, "").trim()
}

export function stripSafeWrappers(command: string): string {
	let stripped = command.trim()
	let prev = ""
	while (stripped !== prev) {
		prev = stripped
		for (const re of SAFE_WRAPPER_PREFIXES) {
			const next = stripped.replace(re, "")
			if (next !== stripped) {
				stripped = next.trim()
				break
			}
		}
	}
	return stripped
}

export function stripAllLeadingEnvVars(command: string): string {
	let stripped = command.trim()
	let prev = ""
	while (stripped !== prev) {
		prev = stripped
		const m = stripped.match(ENV_VAR_PATTERN)
		if (!m) break
		stripped = stripped.slice(m[0].length).trim()
	}
	return stripped
}

export function stripSafeLeadingEnvVars(command: string): string {
	let stripped = command.trim()
	let prev = ""
	while (stripped !== prev) {
		prev = stripped
		const m = stripped.match(ENV_VAR_PATTERN)
		if (!m) break
		const varName = m[1]!.split("=")[0]!.replace(/\[.*$/, "")
		if (!SAFE_ENV_VARS.has(varName)) break
		stripped = stripped.slice(m[0].length).trim()
	}
	return stripped
}

function buildCommandCandidates(
	command: string,
	stripAllEnv: boolean,
): string[] {
	const base = stripOutputRedirections(command)
	const seen = new Set<string>()
	const out: string[] = []

	const push = (s: string) => {
		const t = s.trim()
		if (t && !seen.has(t)) {
			seen.add(t)
			out.push(t)
		}
	}

	push(base)
	push(stripSafeWrappers(base))

	if (stripAllEnv) {
		let start = 0
		while (start < out.length) {
			const end = out.length
			for (let i = start; i < end; i++) {
				push(stripAllLeadingEnvVars(out[i]!))
				push(stripSafeWrappers(out[i]!))
			}
			start = end
		}
	} else {
		for (const cmd of [...out]) {
			push(stripSafeLeadingEnvVars(cmd))
		}
	}

	return out
}

function parseRuleContent(content: string | undefined): ShellPermissionRule | null {
	if (content === undefined) return null
	return parsePermissionRule(content)
}

function commandMatchesRule(
	command: string,
	rule: ShellPermissionRule,
	behavior: "allow" | "deny" | "ask",
): boolean {
	const stripAllEnv = behavior !== "allow"
	const candidates = buildCommandCandidates(command, stripAllEnv)
	const matchMode = behavior === "allow" ? "prefix" : "prefix"
	const allowCompound = behavior !== "allow"

	for (const cmd of candidates) {
		const segments = splitShellSegments(cmd)
		const segmentsToCheck =
			behavior === "allow"
				? segments.length === 1
					? segments
					: []
				: segments.length > 0
					? segments
					: [cmd]

		for (const seg of segmentsToCheck) {
			const segTrim = seg.trim()
			if (!segTrim) continue
			const isCompound = splitShellSegments(segTrim).length > 1
			if (
				matchShellRule(
					rule,
					segTrim,
					matchMode,
					behavior === "allow" ? !isCompound : true,
				)
			) {
				return true
			}
			if (rule.type === "exact" && rule.command === segTrim) {
				return true
			}
		}

		// Tool-wide Bash rule (no content) matches any command
		if (rule.type === "exact" && rule.command === "*") {
			return true
		}
	}

	return false
}

export function bashCommandMatchesRuleContent(
	command: string,
	ruleContent: string | undefined,
	behavior: "allow" | "deny" | "ask",
): boolean {
	if (ruleContent === undefined) {
		// Bare Bash — matches all commands
		return true
	}
	const rule = parseRuleContent(ruleContent)
	if (!rule) return false
	return commandMatchesRule(command, rule, behavior)
}

export function suggestBashAllowRule(command: string): string {
	const trimmed = command.trim()
	if (!trimmed) return "Bash"

	// For multi-line commands, use the first line
	const firstLine = trimmed.includes("\n") ? trimmed.split("\n")[0]!.trim() : trimmed

	const tokens = firstLine.split(/\s+/).filter(Boolean)
	// Skip leading env var assignments
	let i = 0
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
		i++
	}

	const baseCmd = tokens[i]
	if (!baseCmd) return "Bash"

	// Package managers and git: suggest broad tool-wide rule
	const BROAD_RULE_COMMANDS = new Set([
		"npm", "pnpm", "yarn", "bun", "git", "cargo", "go", "docker", "make",
	])
	if (BROAD_RULE_COMMANDS.has(baseCmd)) {
		return `Bash(${baseCmd}:*)`
	}

	// Other commands: suggest two-level prefix (command + subcommand)
	const subCmd = tokens[i + 1]
	if (subCmd && !subCmd.startsWith("-")) {
		return `Bash(${baseCmd} ${subCmd}:*)`
	}
	return `Bash(${baseCmd}:*)`
}

function escapeBashRuleContent(content: string): string {
	return content
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)")
}
