/**
 * Load / persist permission rules from global + project scopes.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs"
import path from "node:path"
import {
	getConfigPath,
	setConfigPath,
	loadPermissionModesConfig,
	type PermissionModesConfig,
} from "./config.ts"
import { getProjectId } from "./utils.ts"
import {
	type PermissionBehavior,
	type PermissionRule,
	type PermissionsConfig,
	mergePermissionRules,
	rulesFromPermissionsConfig,
} from "./permissions.ts"
import {
	permissionRuleValueFromString,
	permissionRuleValueToString,
} from "./permission-rule-parser.ts"

export type PermissionRuleDestination = "global" | "project" | "local"

export function setGlobalConfigPathForTests(p: string): void {
	setConfigPath(p)
}

export function getProjectPermissionsDir(cwd: string): string {
	const id = getProjectId(cwd)
	return path.join(cwd, ".pi", "projects", id)
}

export function getProjectPermissionsPath(
	cwd: string,
	local = false,
): string {
	const dir = getProjectPermissionsDir(cwd)
	return path.join(
		dir,
		local ? "permissions.local.json" : "permissions.json",
	)
}

function readJsonFile(filePath: string): PermissionsConfig | null {
	try {
		if (!existsSync(filePath)) return null
		const raw = readFileSync(filePath, "utf-8")
		if (!raw.trim()) return null
		const parsed = JSON.parse(raw) as {
			permissions?: PermissionsConfig
		} & PermissionsConfig
		if (parsed.permissions) return parsed.permissions
		if (parsed.allow || parsed.deny || parsed.ask) return parsed
		return null
	} catch (err) {
		console.warn(`[permission-modes] Failed to read ${filePath}:`, err)
		return null
	}
}

function loadGlobalPermissions(): PermissionRule[] {
	const config = loadPermissionModesConfig()
	const perms = config.permissions
	if (!perms) return []
	return rulesFromPermissionsConfig(perms, "global")
}

function loadProjectPermissions(
	cwd: string,
	local: boolean,
): PermissionRule[] {
	const filePath = getProjectPermissionsPath(cwd, local)
	const perms = readJsonFile(filePath)
	if (!perms) return []
	return rulesFromPermissionsConfig(
		perms,
		local ? "local" : "project",
	)
}

export function loadMergedPermissionRules(cwd: string): PermissionRule[] {
	return mergePermissionRules(
		loadGlobalPermissions(),
		loadProjectPermissions(cwd, false),
		loadProjectPermissions(cwd, true),
	)
}

function normalizeRuleString(rule: string): string {
	return permissionRuleValueToString(permissionRuleValueFromString(rule))
}

function writePermissionsToFile(
	filePath: string,
	behavior: PermissionBehavior,
	newRules: string[],
	isGlobalConfig: boolean,
): boolean {
	try {
		mkdirSync(path.dirname(filePath), { recursive: true })

		let data: Record<string, unknown> = {}
		if (existsSync(filePath)) {
			const raw = readFileSync(filePath, "utf-8")
			if (raw.trim()) {
				data = JSON.parse(raw) as Record<string, unknown>
			}
		}

		const existing =
			(isGlobalConfig
				? ((data.permissions as PermissionsConfig | undefined) ??
					(data as PermissionsConfig))
				: ((data.permissions as PermissionsConfig | undefined) ??
					(data as PermissionsConfig))) ?? {}

		const behaviorList = [...(existing[behavior] ?? [])]
		const normalizedSet = new Set(
			behaviorList.map((r) => normalizeRuleString(String(r))),
		)

		for (const rule of newRules) {
			const norm = normalizeRuleString(rule)
			if (!normalizedSet.has(norm)) {
				behaviorList.push(norm)
				normalizedSet.add(norm)
			}
		}

		const updatedPerms: PermissionsConfig = {
			...existing,
			[behavior]: behaviorList,
		}

		if (isGlobalConfig) {
			data.permissions = updatedPerms
		} else {
			data = { permissions: updatedPerms }
		}

		writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8")
		return true
	} catch (err) {
		console.warn(`[permission-modes] Failed to write ${filePath}:`, err)
		return false
	}
}

export function addPermissionRule(opts: {
	rule: string
	behavior: PermissionBehavior
	destination: PermissionRuleDestination
	cwd: string
}): boolean {
	const norm = normalizeRuleString(opts.rule)

	if (opts.destination === "global") {
		return writePermissionsToFile(
			getConfigPath(),
			opts.behavior,
			[norm],
			true,
		)
	}

	const filePath = getProjectPermissionsPath(
		opts.cwd,
		opts.destination === "local",
	)

	if (opts.destination === "local") {
		ensureLocalPermissionsGitignored(opts.cwd)
	}

	return writePermissionsToFile(filePath, opts.behavior, [norm], false)
}

function ensureLocalPermissionsGitignored(cwd: string): void {
	const localPath = getProjectPermissionsPath(cwd, true)
	const gitignorePath = path.join(cwd, ".gitignore")
	const entry = path.relative(cwd, localPath)
	if (!existsSync(gitignorePath)) return
	try {
		const content = readFileSync(gitignorePath, "utf-8")
		if (content.split("\n").some((line) => line.trim() === entry)) return
	} catch {
		return
	}
}

export function warnIfLocalPermissionsNotGitignored(
	cwd: string,
	notify?: (msg: string) => void,
): void {
	const localPath = getProjectPermissionsPath(cwd, true)
	if (!existsSync(localPath)) return
	const gitignorePath = path.join(cwd, ".gitignore")
	const entry = path.relative(cwd, localPath)
	if (!existsSync(gitignorePath)) {
		notify?.(
			`Tip: add ${entry} to .gitignore to keep personal permission rules private`,
		)
		return
	}
	try {
		const content = readFileSync(gitignorePath, "utf-8")
		if (!content.split("\n").some((line) => line.trim() === entry)) {
			notify?.(
				`Tip: add ${entry} to .gitignore to keep personal permission rules private`,
			)
		}
	} catch {
		/* ignore */
	}
}

/** For tests: write raw project permissions file. */
export function writeProjectPermissionsFile(
	cwd: string,
	perms: PermissionsConfig,
	local = false,
): void {
	const filePath = getProjectPermissionsPath(cwd, local)
	mkdirSync(path.dirname(filePath), { recursive: true })
	writeFileSync(
		filePath,
		JSON.stringify({ permissions: perms }, null, 2) + "\n",
		"utf-8",
	)
}

/** For tests: write global permission-modes.json permissions block. */
export function writeGlobalPermissionsConfig(
	perms: PermissionsConfig,
	configPath?: string,
): void {
	const filePath = configPath ?? getConfigPath()
	let data: PermissionModesConfig = {}
	if (existsSync(filePath)) {
		try {
			data = JSON.parse(readFileSync(filePath, "utf-8")) as PermissionModesConfig
		} catch {
			data = {}
		}
	}
	data.permissions = perms
	mkdirSync(path.dirname(filePath), { recursive: true })
	writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8")
}
