/**
 * Session-scoped approvals — "Allow for session" memory.
 */

import path from "node:path";
import type { Surface } from "./schema.ts";

export class SessionApprovals {
  private store = new Map<string, Map<Surface, Set<string>>>();

  has(mode: string, surface: Surface, target: string): boolean {
    return this.store.get(mode)?.get(surface)?.has(target) ?? false;
  }

  remember(mode: string, surface: Surface, target: string): void {
    let bySurface = this.store.get(mode);
    if (!bySurface) {
      bySurface = new Map();
      this.store.set(mode, bySurface);
    }
    let set = bySurface.get(surface);
    if (!set) {
      set = new Set();
      bySurface.set(surface, set);
    }
    set.add(target);
  }

  clearMode(mode: string): void {
    this.store.delete(mode);
  }

  clearAll(): void {
    this.store.clear();
  }
}

/**
 * Session-scoped out-of-project paths the user chose to BLOCK ("Deny and
 * block <path> for this session").
 */
export class BlockedPaths {
  private paths = new Set<string>();

  add(p: string): void {
    this.paths.add(p);
  }

  remove(p: string): boolean {
    return this.paths.delete(p);
  }

  covers(p: string): boolean {
    for (const b of this.paths) {
      if (p === b || p.startsWith(b.endsWith(path.sep) ? b : b + path.sep)) return true;
    }
    return false;
  }

  list(): string[] {
    return [...this.paths];
  }

  clear(): void {
    this.paths.clear();
  }
}

/** An extra prompt option that denies AND runs a side effect. */
export interface DenyOption {
  label: string;
  run: () => void | Promise<void>;
}

/** Minimal UI surface needed by `askWithSession`. */
export interface ApprovalUI {
  hasUI: boolean;
  select(title: string, options: string[]): Promise<string | undefined>;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session";
const ALLOW_FOREVER = "Allow forever";
const DENY = "Deny";

/**
 * Prompt for approval, honoring prior "Allow for session" grants. Returns true
 * to allow, false to deny.
 */
export async function askWithSession(
  ui: ApprovalUI,
  approvals: SessionApprovals,
  mode: string,
  surface: Surface,
  target: string | string[],
  title: string,
  onForever?: () => void | Promise<void>,
  denyAnd?: DenyOption,
): Promise<boolean> {
  if (!ui.hasUI) return false;
  const targets = Array.isArray(target) ? target : [target];
  if (targets.length > 0 && targets.every((t) => approvals.has(mode, surface, t))) return true;

  const options = onForever ? [ALLOW_ONCE, ALLOW_SESSION, ALLOW_FOREVER, DENY] : [ALLOW_ONCE, ALLOW_SESSION, DENY];
  if (denyAnd) options.push(denyAnd.label);
  const choice = await ui.select(title, options);
  if (denyAnd && choice === denyAnd.label) {
    await denyAnd.run();
    return false;
  }
  if (choice === ALLOW_FOREVER) {
    for (const t of targets) approvals.remember(mode, surface, t);
    await onForever?.();
    return true;
  }
  if (choice === ALLOW_SESSION) {
    for (const t of targets) approvals.remember(mode, surface, t);
    return true;
  }
  return choice === ALLOW_ONCE;
}
