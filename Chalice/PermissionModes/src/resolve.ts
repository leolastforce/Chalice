/**
 * Resolution engine — turns a (mode, surface, target) into an allow/ask/deny.
 *
 * Two composition rules, mirroring the opencode model:
 *   - within a surface's pattern-map: LAST matching pattern wins (so a leading
 *     `"*"` sets the default and later specific patterns override it);
 *   - across layers (path gate · external_directory · the named surface):
 *     MOST-RESTRICTIVE wins (deny > ask > allow).
 */

import os from "node:os";
import { FILE_SURFACES, type Action, type ModeDef, type Surface, type SurfaceValue } from "./schema.ts";

const RANK: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };

/** Expand a leading `~` or `$HOME` to the user's home directory. */
export function expandHome(s: string): string {
  const home = os.homedir();
  if (s === "~" || s === "$HOME") return home;
  if (s.startsWith("~/")) return home + s.slice(1);
  if (s.startsWith("$HOME/")) return home + s.slice(5);
  return s;
}

/**
 * Glob match: `*` matches any run of characters INCLUDING `/` AND newlines;
 * `?` matches exactly one character, newline included. `~`/`$HOME` are expanded.
 */
export function matchPattern(pattern: string, target: string): boolean {
  const p = expandHome(pattern);
  const t = expandHome(target);
  let re = "^";
  for (const ch of p) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re, "s").test(t);
}

/**
 * Resolve one surface value against a target. String shorthand returns directly;
 * a pattern-map returns the action of the LAST matching pattern.
 */
export function resolveSurface(value: SurfaceValue | undefined, target: string): Action | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  let result: Action | undefined;
  for (const [pattern, action] of Object.entries(value)) {
    if (matchPattern(pattern, target)) result = action;
  }
  return result;
}

/** Most-restrictive of the given actions (deny > ask > allow); undefined ignored. */
export function mostRestrictive(...actions: (Action | undefined)[]): Action | undefined {
  let best: Action | undefined;
  let bestRank = -1;
  for (const a of actions) {
    if (a === undefined) continue;
    if (RANK[a] > bestRank) {
      best = a;
      bestRank = RANK[a];
    }
  }
  return best;
}

/**
 * Decide the action for a (surface, target) under a mode. Folds the cross-cutting
 * `path` gate (file surfaces only) and the `external_directory` gate (when the
 * target is outside the project) into the named surface via most-restrictive.
 */
export function decide(
  mode: ModeDef,
  surface: Surface,
  target: string,
  opts: { isOutside?: boolean; fallback?: Action } = {},
): Action {
  const layers: (Action | undefined)[] = [];

  const sources = mode.projectOverlay ? [mode.permission, mode.projectOverlay] : [mode.permission];
  for (const perm of sources) {
    if (FILE_SURFACES.includes(surface)) layers.push(resolveSurface(perm.path, target));
    if (opts.isOutside) layers.push(resolveSurface(perm.external_directory, target));
    layers.push(resolveSurface(perm[surface], target));
  }

  return mostRestrictive(...layers) ?? opts.fallback ?? "ask";
}

/**
 * Decide the action for ONE extracted bash command (the tree-sitter path, where
 * each command in a chain is judged separately).
 */
export function decideBashCommand(
  mode: ModeDef,
  name: string,
  args: string[],
  aliases: readonly string[] = [],
  pathTokens: readonly string[] = [],
): Action | undefined {
  const tokens = [name, ...args, ...pathTokens];
  const joined = tokens.join(" ").trim();
  const layers: (Action | undefined)[] = [];
  const sources = mode.projectOverlay ? [mode.permission, mode.projectOverlay] : [mode.permission];
  for (const perm of sources) {
    layers.push(resolveSurface(perm.bash, joined));
    for (const alt of aliases) layers.push(resolveSurface(perm.bash, alt));
    layers.push(resolveSurface(perm.path, joined));
    for (const tok of tokens) layers.push(resolveSurface(perm.path, tok));
  }
  return mostRestrictive(...layers);
}

/**
 * Decide the action for a whole parsed bash line: every extracted command is
 * judged with `decideBashCommand` and the chain takes the most restrictive
 * result.
 */
export function decideBashChain(
  mode: ModeDef,
  commands: ReadonlyArray<{ name: string; args: string[]; aliases?: readonly string[]; pathTokens?: readonly string[] }>,
  fallback: Action = "ask",
): Action {
  let result: Action | undefined;
  for (const c of commands) {
    result = mostRestrictive(result, decideBashCommand(mode, c.name, c.args, c.aliases ?? [], c.pathTokens ?? []) ?? fallback);
  }
  return result ?? fallback;
}
