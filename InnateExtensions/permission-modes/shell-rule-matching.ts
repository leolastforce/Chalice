/**
 * CC-compatible shell permission rule matching (exact / :* prefix / wildcard).
 * Ported from Claude Code shellRuleMatching.ts.
 */

const ESCAPED_STAR_PLACEHOLDER = "\x00ESCAPED_STAR\x00"
const ESCAPED_BACKSLASH_PLACEHOLDER = "\x00ESCAPED_BACKSLASH\x00"
const ESCAPED_STAR_PLACEHOLDER_RE = new RegExp(ESCAPED_STAR_PLACEHOLDER, "g")
const ESCAPED_BACKSLASH_PLACEHOLDER_RE = new RegExp(
	ESCAPED_BACKSLASH_PLACEHOLDER,
	"g",
)

export type ShellPermissionRule =
	| { type: "exact"; command: string }
	| { type: "prefix"; prefix: string }
	| { type: "wildcard"; pattern: string }

export function permissionRuleExtractPrefix(
	permissionRule: string,
): string | null {
	const match = permissionRule.match(/^(.+):\*$/)
	return match?.[1] ?? null
}

export function hasWildcards(pattern: string): boolean {
	if (pattern.endsWith(":*")) return false
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i] === "*") {
			let backslashCount = 0
			for (let j = i - 1; j >= 0 && pattern[j] === "\\"; j--) {
				backslashCount++
			}
			if (backslashCount % 2 === 0) return true
		}
	}
	return false
}

export function matchWildcardPattern(
	pattern: string,
	command: string,
	caseInsensitive = false,
): boolean {
	const trimmedPattern = pattern.trim()
	let processed = ""
	let i = 0

	while (i < trimmedPattern.length) {
		const char = trimmedPattern[i]!
		if (char === "\\" && i + 1 < trimmedPattern.length) {
			const nextChar = trimmedPattern[i + 1]!
			if (nextChar === "*") {
				processed += ESCAPED_STAR_PLACEHOLDER
				i += 2
				continue
			}
			if (nextChar === "\\") {
				processed += ESCAPED_BACKSLASH_PLACEHOLDER
				i += 2
				continue
			}
		}
		processed += char
		i++
	}

	const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&")
	const withWildcards = escaped.replace(/\*/g, ".*")
	let regexPattern = withWildcards
		.replace(ESCAPED_STAR_PLACEHOLDER_RE, "\\*")
		.replace(ESCAPED_BACKSLASH_PLACEHOLDER_RE, "\\\\")

	const unescapedStarCount = (processed.match(/\*/g) || []).length
	if (regexPattern.endsWith(" .*") && unescapedStarCount === 1) {
		regexPattern = regexPattern.slice(0, -3) + "( .*)?"
	}

	const flags = "s" + (caseInsensitive ? "i" : "")
	const regex = new RegExp(`^${regexPattern}$`, flags)
	return regex.test(command)
}

export function parsePermissionRule(
	permissionRule: string,
): ShellPermissionRule {
	const prefix = permissionRuleExtractPrefix(permissionRule)
	if (prefix !== null) {
		return { type: "prefix", prefix }
	}
	if (hasWildcards(permissionRule)) {
		return { type: "wildcard", pattern: permissionRule }
	}
	return { type: "exact", command: permissionRule }
}

export function matchShellRule(
	rule: ShellPermissionRule,
	command: string,
	matchMode: "exact" | "prefix",
	allowCompound: boolean,
): boolean {
	const cmd = command.trim()
	if (!cmd) return false

	switch (rule.type) {
		case "exact":
			return rule.command === cmd
		case "prefix": {
			if (matchMode === "exact") {
				return rule.prefix === cmd
			}
			if (!allowCompound && cmd !== rule.prefix) {
				// compound guard handled by caller for allow behavior
			}
			if (cmd === rule.prefix) return true
			if (cmd.startsWith(rule.prefix + " ")) return true
			const xargsPrefix = "xargs " + rule.prefix
			if (cmd === xargsPrefix) return true
			return cmd.startsWith(xargsPrefix + " ")
		}
		case "wildcard":
			if (matchMode === "exact") return false
			return matchWildcardPattern(rule.pattern, cmd)
	}
}
