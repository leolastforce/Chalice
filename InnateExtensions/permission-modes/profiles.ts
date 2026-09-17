/**
 * Pure helpers for the model-profile config.
 *
 * Profiles map each mode (ask / plan / auto / bypass) to a model ID — either
 * `"provider/model"` or `"provider/model:effort"` (with an optional
 * `:effort` suffix that sets the thinking level after the switch) — or to a
 * ModeConfig object with explicit `model` / `effort` / `skills` / `tools`.
 *
 * The config file lives at `~/.pi/agent/model-profiles.json` — a deliberately
 * distinct name from pi's own `models.json` (which is used for custom
 * provider definitions) to avoid format conflict.
 *
 * No pi dependency. All functions are pure (or fs-only with graceful
 * fallback) so they can be unit-tested without mocking the agent runtime.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Per-mode configuration object with optional model, effort, skill, and tool filters. */
export interface ModeConfig {
	model?: string
	/**
	 * Thinking / effort level applied after the model switch
	 * (e.g. `"high"`, `"medium"`, `"off"`). Takes precedence over a
	 * `:suffix` on `model` (e.g. `"provider/model:high"`).
	 */
	effort?: string
	/** Skill name allowlist. ["*"] = all loaded skills. A specific list = only those. */
	skills?: string[]
	/** Tool name allowlist. ["*"] = all active tools. A specific list = only those. */
	tools?: string[]
}

/**
 * One named profile mapping modes to model IDs and/or ModeConfig objects.
 *
 * Backward compat: a bare string `"provider/model:thinking"` is shorthand for
 * `{ model: "provider/model:thinking", skills: ["*"], tools: ["*"] }`.
 */
export interface ModelProfile {
	ask?: string | ModeConfig
	plan?: string | ModeConfig
	auto?: string | ModeConfig
	bypass?: string | ModeConfig
}

/** Full config file shape: an `active` pointer plus any number of named profiles. */
export interface ModelProfilesConfig {
	active?: string
	[key: string]: ModelProfile | string | undefined
}

/** Default = real homedir path. Exposed via getter/setter so tests can
 *  redirect to a tmpdir fixture without breaking the ESM read-only-export
 *  contract (you can't assign to an imported `let` binding). */
let _modelsPath: string = join(
	homedir(),
	".pi",
	"agent",
	"model-profiles.json",
)

export function getModelsPath(): string {
	return _modelsPath
}

export function setModelsPath(p: string): void {
	_modelsPath = p
}

/** Convenience read-only re-export for code that just wants the path. */
export const modelsPath: string = _modelsPath

/**
 * Parse `"provider/model"` or `"provider/model:thinking"` into components.
 * Returns `{ provider, model, thinkingLevel }` or `null` if the input has no
 * slash (no provider), or is empty.
 *
 * A trailing `:` (e.g. `"opencode/big-pickle:"`) is treated as "no thinking
 * suffix" — `thinkingLevel` is omitted in the returned object.
 */
export function parseModelId(
	raw: string,
): { provider: string; model: string; thinkingLevel?: string } | null {
	if (!raw) return null
	const colonIdx = raw.indexOf(":")
	const providerAndModel =
		colonIdx === -1 ? raw : raw.slice(0, colonIdx)
	const thinkingLevel =
		colonIdx === -1 ? undefined : raw.slice(colonIdx + 1) || undefined
	const slashIdx = providerAndModel.indexOf("/")
	if (slashIdx <= 0) return null
	const provider = providerAndModel.slice(0, slashIdx)
	const model = providerAndModel.slice(slashIdx + 1)
	if (!provider || !model) return null
	return thinkingLevel === undefined
		? { provider, model }
		: { provider, model, thinkingLevel }
}

/** Internal: read+parse the config file. Returns {} on any failure. */
function readConfigFromDisk(): ModelProfilesConfig {
	try {
		if (!existsSync(_modelsPath)) return {}
		const raw = readFileSync(_modelsPath, "utf-8")
		if (!raw.trim()) return {}
		return JSON.parse(raw) as ModelProfilesConfig
	} catch (err) {
		console.warn(
			`[permission-modes] Failed to load ${_modelsPath}:`,
			err,
		)
		return {}
	}
}

/**
 * Load and parse the model profiles config file. Returns an empty object if
 * the file doesn't exist or is malformed. Never throws.
 */
export function loadModelProfiles(): ModelProfilesConfig {
	return readConfigFromDisk()
}

/**
 * Ensure the model profiles config file exists. If missing, creates it with
 * defaults — pre-filled with the user's default model from
 * `~/.pi/agent/settings.json` (`defaultProvider` / `defaultModel`) if
 * available.
 *
 * Called once on session start and on `/reload`. Never throws — failures are
 * logged and the in-memory defaults are returned.
 */
export function ensureModelProfilesConfig(): ModelProfilesConfig {
	if (existsSync(_modelsPath)) return readConfigFromDisk()

	// Try to detect default model from pi settings
	let defaultModelId = ""
	try {
		const settingsPath = join(homedir(), ".pi", "agent", "settings.json")
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
			const provider = settings.defaultProvider || ""
			const model = settings.defaultModel || ""
			if (provider && model) defaultModelId = `${provider}/${model}`
		}
	} catch {
		/* ignore — fall back to empty strings */
	}

	const defaults: ModelProfilesConfig = {
		active: "default",
		default: {
			ask: defaultModelId,
			plan: defaultModelId,
			auto: defaultModelId,
		},
	}

	try {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true })
		writeFileSync(_modelsPath, JSON.stringify(defaults, null, 2) + "\n", {
			mode: 0o600,
		})
		console.log(`[permission-modes] Created ${_modelsPath} with defaults`)
	} catch (err) {
		console.warn(
			`[permission-modes] Failed to create ${_modelsPath}:`,
			err,
		)
	}

	return defaults
}

/**
 * Resolve the model ID string for a given mode from the active profile.
 * Falls back to the `default` profile when the active one doesn't define
 * that mode's model (including partial mode objects with only skills/tools).
 * Returns `undefined` when nothing matches.
 */
function modelFromProfileEntry(
	entry: string | ModeConfig | undefined,
): string | undefined {
	if (entry === undefined) return undefined
	if (typeof entry === "string") return entry
	return entry.model
}

export function resolveModelForMode(
	config: ModelProfilesConfig,
	mode: "ask" | "plan" | "auto" | "bypass",
): string | undefined {
	const profileName = config.active || "default"
	const profile = config[profileName] as ModelProfile | undefined
	const fromActive = modelFromProfileEntry(profile?.[mode])
	if (fromActive) return fromActive

	if (profileName !== "default") {
		const def = config["default"] as ModelProfile | undefined
		return modelFromProfileEntry(def?.[mode])
	}
	return undefined
}

/** Default thinking level when a profile mode has no explicit effort / `:suffix`. */
export const DEFAULT_PROFILE_EFFORT = "medium"

/**
 * Resolve the effort / thinking level for a mode from the active profile.
 *
 * Priority:
 *   1. Explicit `ModeConfig.effort` on the resolved mode entry
 *   2. `:suffix` on the model string (e.g. `"provider/model:high"`)
 *   3. {@link DEFAULT_PROFILE_EFFORT} (`"medium"`)
 *
 * Falls back through the `default` profile the same way as
 * {@link resolveModelForMode}.
 */
export function resolveEffortForMode(
	config: ModelProfilesConfig,
	mode: "ask" | "plan" | "auto" | "bypass",
): string {
	const profileName = config.active || "default"
	const profile = config[profileName] as ModelProfile | undefined
	const fromActive = effortFromProfileEntry(profile?.[mode])
	if (fromActive) return fromActive

	if (profileName !== "default") {
		const def = config["default"] as ModelProfile | undefined
		const fromDefault = effortFromProfileEntry(def?.[mode])
		if (fromDefault) return fromDefault
	}
	return DEFAULT_PROFILE_EFFORT
}

function effortFromProfileEntry(
	entry: string | ModeConfig | undefined,
): string | undefined {
	if (entry === undefined) return undefined
	if (typeof entry === "string") {
		return parseModelId(entry)?.thinkingLevel
	}
	const trimmed = entry.effort?.trim()
	if (trimmed) return trimmed
	if (entry.model) return parseModelId(entry.model)?.thinkingLevel
	return undefined
}

/**
 * Get the active profile name, defaulting to `"default"`.
 */
export function getActiveProfileName(config: ModelProfilesConfig): string {
	return config.active || "default"
}

/**
 * List all profile names (keys whose value is an object, excluding `active`).
 */
export function listProfiles(config: ModelProfilesConfig): string[] {
	return Object.keys(config).filter(
		(k) => k !== "active" && typeof config[k] === "object",
	)
}

/**
 * Normalize a raw profile mode entry (string or ModeConfig) into a canonical
 * ModeConfig object. Returns a default ModeConfig (skills:["*"], tools:["*"])
 * when entry is undefined.
 */
function normalizeModeEntry(
	entry: string | ModeConfig | undefined,
): ModeConfig {
	if (entry === undefined) return { skills: ["*"], tools: ["*"] }
	if (typeof entry === "string") return { model: entry, skills: ["*"], tools: ["*"] }
	return {
		model: entry.model,
		effort: entry.effort,
		skills: entry.skills ?? ["*"],
		tools: entry.tools ?? ["*"],
	}
}

/**
 * Resolve the effective ModeConfig for a given mode from the active profile,
 * falling back through defaults.
 *
 * Resolution order:
 *   1. Active profile's mode entry (normalized to ModeConfig)
 *   2. "default" profile's mode entry (normalized to ModeConfig)
 *   3. Hardcoded fallback: { skills: ["*"], tools: ["*"] }
 *
 * Never returns undefined — always returns at least the hardcoded fallback.
 */
export function resolveModeConfig(
	config: ModelProfilesConfig,
	mode: "ask" | "plan" | "auto" | "bypass",
): ModeConfig {
	const profileName = config.active || "default"

	// Try active profile
	const profile = config[profileName] as ModelProfile | undefined
	if (profile) {
		const entry = profile[mode]
		if (entry !== undefined) return normalizeModeEntry(entry)
	}

	// Fall back to "default" profile
	if (profileName !== "default") {
		const def = config["default"] as ModelProfile | undefined
		if (def) {
			const entry = def[mode]
			if (entry !== undefined) return normalizeModeEntry(entry)
		}
	}

	// Hardcoded fallback
	return { skills: ["*"], tools: ["*"] }
}

/**
 * Resolve the effective skill allowlist for a mode.
 * Returns ["*"] when no filter is configured (allow all).
 */
export function resolveSkillFilter(
	config: ModelProfilesConfig,
	mode: "ask" | "plan" | "auto" | "bypass",
): string[] {
	return resolveModeConfig(config, mode).skills ?? ["*"]
}

/**
 * Resolve the effective tool allowlist for a mode.
 * Returns "*" when no filter is configured (allow all tools).
 *
 * Invariants (v1.1.4 stub — full implementation in v1.1.5):
 *   - `read` is always mandatory in ALL modes
 *   - Plan mode: `edit` and `write` are always excluded
 *
 * NOTE: This is a STUB for v1.1.4 — the full re-write of
 * `applyToolRestrictions()` happens in v1.1.5. The stub returns the raw
 * filter from config with `read` re-injected. Plan-mode disabled set
 * enforcement is deferred to v1.1.5.
 */
export function resolveToolFilter(
	config: ModelProfilesConfig,
	mode: "ask" | "plan" | "auto",
): string[] | "*" {
	const mc = resolveModeConfig(config, mode)
	const raw = mc.tools ?? ["*"]
	if (raw.length === 1 && raw[0] === "*") return "*"
	// Ensure read is always present
	return [...new Set([...raw, "read"])]
}

/**
 * Check whether a profile with the given name exists (i.e. is an object entry
 * in the config). `active` is treated as a string pointer, not a profile.
 */
export function profileExists(
	config: ModelProfilesConfig,
	name: string,
): boolean {
	return typeof config[name] === "object" && config[name] !== null
}