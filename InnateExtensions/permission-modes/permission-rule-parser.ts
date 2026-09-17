/**
 * CC-compatible permission rule parsing: Tool or Tool(content).
 * Ported from Claude Code permissionRuleParser.ts (subset).
 */

export interface PermissionRuleValue {
	toolName: string
	ruleContent?: string
}

export function escapeRuleContent(content: string): string {
	return content
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)")
}

export function unescapeRuleContent(content: string): string {
	return content
		.replace(/\\\(/g, "(")
		.replace(/\\\)/g, ")")
		.replace(/\\\\/g, "\\")
}

function findFirstUnescapedChar(str: string, char: string): number {
	for (let i = 0; i < str.length; i++) {
		if (str[i] === char) {
			let backslashCount = 0
			for (let j = i - 1; j >= 0 && str[j] === "\\"; j--) {
				backslashCount++
			}
			if (backslashCount % 2 === 0) return i
		}
	}
	return -1
}

function findLastUnescapedChar(str: string, char: string): number {
	for (let i = str.length - 1; i >= 0; i--) {
		if (str[i] === char) {
			let backslashCount = 0
			for (let j = i - 1; j >= 0 && str[j] === "\\"; j--) {
				backslashCount++
			}
			if (backslashCount % 2 === 0) return i
		}
	}
	return -1
}

export function permissionRuleValueFromString(
	ruleString: string,
): PermissionRuleValue {
	const openParenIndex = findFirstUnescapedChar(ruleString, "(")
	if (openParenIndex === -1) {
		return { toolName: ruleString.trim() }
	}

	const closeParenIndex = findLastUnescapedChar(ruleString, ")")
	if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
		return { toolName: ruleString.trim() }
	}

	if (closeParenIndex !== ruleString.length - 1) {
		return { toolName: ruleString.trim() }
	}

	const toolName = ruleString.substring(0, openParenIndex).trim()
	const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex)

	if (!toolName) {
		return { toolName: ruleString.trim() }
	}

	if (rawContent === "" || rawContent === "*") {
		return { toolName }
	}

	return {
		toolName,
		ruleContent: unescapeRuleContent(rawContent),
	}
}

export function permissionRuleValueToString(
	ruleValue: PermissionRuleValue,
): string {
	if (!ruleValue.ruleContent) {
		return ruleValue.toolName
	}
	return `${ruleValue.toolName}(${escapeRuleContent(ruleValue.ruleContent)})`
}
