/**
 * Read / Edit / Write path permission matching (CC filesystem rules subset).
 */

import path from "node:path"
import { homedir } from "node:os"

function expandUserPath(p: string): string {
	const home = homedir()
	if (p === "~") return home
	if (p.startsWith("~/")) return path.join(home, p.slice(2))
	return p
}

/** Resolve a rule path pattern relative to project cwd. */
export function resolveRulePath(pattern: string, cwd: string): string {
	const p = expandUserPath(pattern.trim())
	if (p.startsWith("//")) {
		return path.resolve(p.slice(1))
	}
	if (path.isAbsolute(p)) {
		return path.resolve(p)
	}
	if (p.startsWith("./") || p.startsWith(".\\")) {
		return path.resolve(cwd, p)
	}
	if (p.startsWith("~/")) {
		return path.resolve(expandUserPath(p))
	}
	// Relative to project root (no prefix)
	return path.resolve(cwd, p)
}

function escapeRegex(s: string): string {
	return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
}

/** Convert CC-style path glob to regex (supports * and **). */
function globToRegex(globPattern: string): RegExp {
	let g = globPattern.replace(/\\/g, "/")
	g = g.replace(/\*\*/g, "\x00GLOBSTAR\x00")
	g = escapeRegex(g)
	g = g.replace(/\x00GLOBSTAR\x00/g, ".*")
	g = g.replace(/\\\*/g, "[^/]*")
	return new RegExp(`^${g}$`)
}

export function pathMatchesRulePattern(
	targetPath: string,
	rulePattern: string,
	cwd: string,
): boolean {
	if (!rulePattern || rulePattern === "*") return true

	const resolvedTarget = path.resolve(
		path.isAbsolute(expandUserPath(targetPath))
			? expandUserPath(targetPath)
			: path.resolve(cwd, targetPath),
	)

	const normalizedTarget =
		process.platform === "win32"
			? resolvedTarget.replace(/\\/g, "/")
			: resolvedTarget

	const ruleResolved = resolveRulePath(rulePattern, cwd)
	const normalizedRule =
		process.platform === "win32"
			? ruleResolved.replace(/\\/g, "/")
			: ruleResolved

	const ruleForGlob =
		rulePattern.includes("*") || rulePattern.includes("**")
			? normalizedRule
			: normalizedRule

	if (rulePattern.includes("*")) {
		return globToRegex(ruleForGlob).test(normalizedTarget)
	}

	// Exact path or directory prefix
	if (normalizedTarget === normalizedRule) return true
	if (normalizedRule.endsWith("/")) {
		return normalizedTarget.startsWith(normalizedRule)
	}
	return (
		normalizedTarget.startsWith(normalizedRule + "/") ||
		normalizedTarget === normalizedRule
	)
}

export function suggestPathAllowRule(
	toolName: "Read" | "Edit" | "Write",
	targetPath: string,
	cwd: string,
): string {
	const resolved = path.isAbsolute(expandUserPath(targetPath))
		? expandUserPath(targetPath)
		: path.resolve(cwd, targetPath)

	const rel = path.relative(cwd, resolved)
	if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
		if (rel.includes(path.sep)) {
			const dir = rel.split(path.sep)[0]
			return `${toolName}(./${dir}/**)`
		}
		return `${toolName}(./${rel})`
	}

	if (targetPath.startsWith("~/")) {
		return `${toolName}(${targetPath})`
	}

	return `${toolName}(${targetPath})`
}

export function pathToolMatchesRuleContent(
	toolName: "Read" | "Edit" | "Write",
	targetPath: string,
	ruleContent: string | undefined,
	cwd: string,
): boolean {
	if (ruleContent === undefined) {
		return true
	}
	return pathMatchesRulePattern(targetPath, ruleContent, cwd)
}
