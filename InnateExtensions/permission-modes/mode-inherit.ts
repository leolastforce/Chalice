/**
 * Inherit the interactive parent's permission mode into headless subagent
 * children via process env (pi-subagents merges `process.env` into spawn env).
 */

import {
	isSubagentChildProcess,
	SUBAGENT_CHILD_ENV,
} from "./permission-forwarding.ts";

/** Written by the parent session; read by PI_SUBAGENT_CHILD processes. */
export const PERMISSION_MODES_INHERITED_MODE_ENV =
	"PERMISSION_MODES_INHERITED_MODE";

export const INHERITABLE_MODES = [
	"ask",
	"plan",
	"auto",
	"bypass",
] as const;

export type InheritableMode = (typeof INHERITABLE_MODES)[number];

export function isInheritableMode(value: string): value is InheritableMode {
	return (INHERITABLE_MODES as readonly string[]).includes(value);
}

/**
 * Publish the live mode so subsequently spawned subagents inherit it.
 * No-op in child processes (they keep the value received at spawn).
 */
export function publishInheritedPermissionMode(mode: string): void {
	if (isSubagentChildProcess()) return;
	if (!isInheritableMode(mode)) return;
	process.env[PERMISSION_MODES_INHERITED_MODE_ENV] = mode;
}

/** Read parent mode from env (set at spawn via merged process.env). */
export function resolveInheritedPermissionMode(): InheritableMode | undefined {
	const raw = process.env[PERMISSION_MODES_INHERITED_MODE_ENV]?.trim();
	if (!raw || !isInheritableMode(raw)) return undefined;
	return raw;
}

/**
 * For subagent children: always prefer the parent's live mode from env when
 * present (overrides flag + session restore). Parent bypass must mean child
 * bypass — otherwise review fan-out keeps prompting on the parent UI.
 */
export function applyInheritedModeForChild(_opts?: {
	flagSet?: boolean;
	currentMode?: string;
}): InheritableMode | undefined {
	if (!isSubagentChildProcess()) return undefined;
	return resolveInheritedPermissionMode();
}

export { SUBAGENT_CHILD_ENV };
