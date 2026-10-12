/**
 * Session scratch directory — the per-session temp folder the agent is told
 * to use for throwaway files.
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxProfile } from "./schema.ts";

export const SCRATCH_BASE_ENV = "PI_PERMISSION_TMPDIR";
export const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function scratchBaseOverridden(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SCRATCH_BASE_ENV]?.trim());
}

export function scratchBase(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SCRATCH_BASE_ENV]?.trim();
  if (override) return path.resolve(override);
  return platform === "linux" || platform === "darwin" ? "/tmp/pi" : path.join(os.tmpdir(), "pi");
}

export function scratchDirName(sessionId: string | undefined, fallback: () => string = () => `${process.pid}-${Date.now().toString(36)}`): string {
  const safe = (sessionId ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  return safe || fallback();
}

export function ensureScratchDir(dir: string, opts: { sharedBase?: boolean } = {}): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const ownRealDir = (p: string): boolean => {
    const st = lstatSync(p);
    if (!st.isDirectory()) return false;
    return uid === undefined || st.uid === uid;
  };
  try {
    const base = path.dirname(dir);
    let baseExisted = true;
    try {
      lstatSync(base);
    } catch {
      baseExisted = false;
    }
    if (!baseExisted) {
      mkdirSync(base, { recursive: true });
      if (opts.sharedBase) {
        try {
          chmodSync(base, 0o1777);
        } catch {
          // ignore
        }
      }
    } else if (lstatSync(base).isSymbolicLink()) {
      return false;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!ownRealDir(dir)) return false;
    try {
      chmodSync(dir, 0o700);
    } catch {
      // ignore
    }
    const now = new Date();
    utimesSync(dir, now, now);
    return true;
  } catch {
    return false;
  }
}

export function sweepScratchDirs(
  base: string,
  keep: string,
  opts: { maxAgeMs?: number; now?: number } = {},
): string[] {
  const maxAge = opts.maxAgeMs ?? SCRATCH_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const keepName = path.basename(keep);
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name === keepName) continue;
    const p = path.join(base, name);
    try {
      const st = lstatSync(p);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < maxAge) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // ignore
    }
  }
  return removed;
}

export function withScratchDir(profile: SandboxProfile, dir: string | undefined): SandboxProfile {
  if (!dir || !profile.enabled) return profile;
  const allowWrite = profile.allowWrite ?? [];
  if (allowWrite.includes(dir)) return profile;
  return { ...profile, allowWrite: [...allowWrite, dir] };
}
