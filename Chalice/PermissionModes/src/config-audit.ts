/**
 * Config audit - keeps a user's global permission-mode.json from silently
 * falling behind shipped defaults.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DefaultsVersion {
  from: string;
  to: string;
  defaults: unknown;
}

export interface StaleFinding {
  path: string;
  value: unknown;
  currentValue: unknown;
  from: string;
  to: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split("-")[0]!.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function configLeaves(raw: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!isObject(raw)) return out;
  for (const k of ["defaultMode", "cycleOrder"]) if (k in raw) out.set(k, raw[k]);
  const modes = isObject(raw.modes) ? raw.modes : {};
  for (const [name, m] of Object.entries(modes)) {
    if (!isObject(m)) continue;
    for (const [k, v] of Object.entries(m)) {
      if ((k === "sandbox" || k === "permission") && isObject(v)) {
        for (const [k2, v2] of Object.entries(v)) out.set(`modes.${name}.${k}.${k2}`, v2);
      } else {
        out.set(`modes.${name}.${k}`, v);
      }
    }
  }
  return out;
}

export function defaultsFor(
  version: string,
  current: { version: string; defaults: unknown },
  history: DefaultsVersion[],
): unknown | undefined {
  if (version === current.version) return current.defaults;
  const hit = history.find((h) => compareVersions(h.from, version) <= 0 && compareVersions(version, h.to) <= 0);
  return hit?.defaults;
}

export function auditStaleDefaults(
  raw: unknown,
  current: { version: string; defaults: unknown },
  history: DefaultsVersion[],
  acknowledged?: string,
): StaleFinding[] {
  if (acknowledged) {
    const ackDefaults = defaultsFor(acknowledged, current, history);
    if (ackDefaults !== undefined && sameValue(ackDefaults, current.defaults)) return [];
  }
  const cur = configLeaves(current.defaults);
  const hist = [...history]
    .sort((a, b) => compareVersions(b.to, a.to))
    .map((h) => ({ ...h, leaves: configLeaves(h.defaults) }));
  const findings: StaleFinding[] = [];
  for (const [p, value] of configLeaves(raw)) {
    if (!cur.has(p)) continue;
    const currentValue = cur.get(p);
    if (sameValue(value, currentValue)) continue;
    const matches = hist.filter((h) => h.leaves.has(p) && sameValue(h.leaves.get(p), value));
    if (matches.length > 0) {
      const from = matches.reduce((a, h) => (compareVersions(h.from, a) < 0 ? h.from : a), matches[0]!.from);
      const to = matches.reduce((a, h) => (compareVersions(h.to, a) > 0 ? h.to : a), matches[0]!.to);
      findings.push({ path: p, value, currentValue, from, to });
    }
  }
  return findings;
}

export function defaultsChangedSince(
  fromVersion: string,
  current: { version: string; defaults: unknown },
  history: DefaultsVersion[],
): string[] {
  const old = defaultsFor(fromVersion, current, history);
  if (old === undefined) return [];
  const a = configLeaves(old);
  const b = configLeaves(current.defaults);
  const changed: string[] = [];
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    if (!sameValue(a.get(p), b.get(p))) changed.push(p);
  }
  return changed;
}

const pkgRoot = (): URL => new URL("../", import.meta.url);

export function extensionVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", pkgRoot())), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function loadDefaultsHistory(): DefaultsVersion[] {
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL("defaults-history.json", pkgRoot())), "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (h): h is DefaultsVersion => isObject(h) && typeof h.from === "string" && typeof h.to === "string" && "defaults" in h,
    );
  } catch {
    return [];
  }
}

export interface AuditState {
  lastVersion?: string;
}

export function auditStateFile(agentDir: string): string {
  return path.join(agentDir, "permission-mode", "state.json");
}

export function readAuditState(agentDir: string): AuditState {
  try {
    const raw = JSON.parse(readFileSync(auditStateFile(agentDir), "utf-8")) as unknown;
    return isObject(raw) && typeof raw.lastVersion === "string" ? { lastVersion: raw.lastVersion } : {};
  } catch {
    return {};
  }
}

export function writeAuditState(agentDir: string, state: AuditState): boolean {
  try {
    const file = auditStateFile(agentDir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function describeStale(f: StaleFinding): string {
  const range = f.from === f.to ? f.from : `${f.from} to ${f.to}`;
  return `${f.path} still holds the ${range} default ${JSON.stringify(f.value)}; the current default is ${JSON.stringify(f.currentValue)}`;
}

export function hasGlobalConfig(agentDir: string): boolean {
  return existsSync(path.join(agentDir, "permission-mode", "permission-mode.json"));
}
