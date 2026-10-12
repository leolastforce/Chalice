/**
 * Mode-config loading and layered merge.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanApprovalConfig } from "./plan-approval.ts";
import {
  type Action,
  type ModeDef,
  PLAN_PROMPT_SENTINEL,
  type PermissionModeConfig,
  type SandboxProfile,
  type SurfaceValue,
  type Surface,
  SURFACES,
} from "./schema.ts";

type OnError = (message: string) => void;
const noop: OnError = () => {};

export const SCHEMA_URL = "https://raw.githubusercontent.com/wynainfo/pi-permission-modes/main/schemas/permission-mode.schema.json";

const MAX_CONFIG_BYTES = 1 << 20;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function safeEntries(v: unknown): [string, unknown][] {
  if (!isPlainObject(v)) return [];
  return Object.entries(v).filter(([k]) => !UNSAFE_KEYS.has(k));
}

function modeEntries(v: unknown, where: string, onError: OnError): [string, unknown][] {
  if (!isPlainObject(v)) return [];
  for (const k of Object.keys(v)) {
    if (UNSAFE_KEYS.has(k)) onError(`permission-mode: ignoring mode "${k}" in ${where}: not a valid mode name`);
  }
  return safeEntries(v);
}

export function hasMode(modes: Record<string, unknown>, name: unknown): name is string {
  return typeof name === "string" && !UNSAFE_KEYS.has(name) && Object.hasOwn(modes, name);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const MODE_COLORS = new Set(["muted", "mdLink", "accent", "error"]);

function sanitizeSandbox(raw: unknown, where: string, onError: OnError): Partial<SandboxProfile> {
  if (!isPlainObject(raw)) {
    if (raw !== undefined) onError(`permission-mode: sandbox in ${where} must be an object; ignoring`);
    return {};
  }
  const out: Partial<SandboxProfile> = {};
  const drop = (k: string) => onError(`permission-mode: ignoring sandbox.${k} in ${where}: wrong type`);
  for (const [k, v] of safeEntries(raw)) {
    switch (k) {
      case "enabled":
      case "writable":
      case "askOnBlockedHost":
        if (typeof v === "boolean") out[k] = v;
        else drop(k);
        break;
      case "allowWrite":
      case "denyWrite":
      case "denyRead":
      case "allowRead":
        if (isStringArray(v)) out[k] = v;
        else drop(k);
        break;
      case "network": {
        if (!isPlainObject(v)) {
          drop(k);
          break;
        }
        const net: NonNullable<SandboxProfile["network"]> = {};
        if (v.allowedDomains !== undefined) {
          if (isStringArray(v.allowedDomains)) net.allowedDomains = v.allowedDomains;
          else drop("network.allowedDomains");
        }
        if (v.deniedDomains !== undefined) {
          if (isStringArray(v.deniedDomains)) net.deniedDomains = v.deniedDomains;
          else drop("network.deniedDomains");
        }
        out.network = net;
        break;
      }
      default:
        onError(`permission-mode: ignoring unknown sandbox field "${k}" in ${where}`);
    }
  }
  return out;
}

export const FALLBACK_CONFIG: PermissionModeConfig = {
  defaultMode: "yolo",
  cycleOrder: ["yolo", "plan", "build", "confirm", "debug", "default"],
  modes: {
    yolo: {
      label: "YOLO",
      color: "error",
      systemPrompt: "You are in YOLO mode. You have full tool access and project edits are applied directly without sandboxing or prompts.",
      sandbox: { enabled: false, writable: true },
      bypassProtectedPaths: true,
      permission: {
        path: { "*": "allow" },
        external_directory: "allow",
        read: "allow",
        write: "allow",
        edit: "allow",
        grep: "allow",
        find: "allow",
        ls: "allow",
        bash: { "*": "allow" },
        web_search: "allow",
        tool: "allow",
        skill: "allow",
      },
    },
    default: {
      label: "Default",
      color: "muted",
      sandbox: {
        enabled: true,
        writable: true,
        allowWrite: ["."],
        denyWrite: [],
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
        network: { allowedDomains: [], deniedDomains: [] },
      },
      permission: {
        path: { "*": "allow" },
        external_directory: "ask",
        read: "allow",
        grep: "allow",
        find: "allow",
        ls: "allow",
        write: "ask",
        edit: "ask",
        bash: { "*": "ask" },
        web_search: "ask",
        tool: "ask",
        skill: "ask",
      },
    },
  },
};

export interface SandboxConfig {
  enabled?: boolean;
  network: { allowedDomains?: string[]; deniedDomains: string[] };
  filesystem: { denyRead: string[]; allowRead?: string[]; allowWrite: string[]; denyWrite: string[] };
}

export function profileToConfig(p: SandboxProfile): SandboxConfig {
  return {
    enabled: p.enabled,
    network: { allowedDomains: p.network?.allowedDomains, deniedDomains: p.network?.deniedDomains ?? [] },
    filesystem: {
      denyRead: p.denyRead ?? [],
      ...(p.allowRead ? { allowRead: p.allowRead } : {}),
      allowWrite: p.allowWrite ?? [],
      denyWrite: p.denyWrite ?? [],
    },
  };
}

export function readOnlyOverride(config: SandboxConfig, keepWritable: string[] = []): SandboxConfig {
  return { ...config, filesystem: { ...config.filesystem, allowWrite: [...keepWritable] } };
}

export function isUnsafeDomain(d: string): boolean {
  if (d === "*") return true;
  if (/[/:]/.test(d)) return true;
  if (/^\*\.[^.]+$/.test(d)) return true;
  return false;
}

function union(a: string[] = [], b: string[] = []): string[] {
  return [...new Set([...a, ...b])];
}

function intersect(a: string[] = [], b: string[] = []): string[] {
  return a.filter((x) => b.includes(x));
}

function isAction(v: unknown): v is Action {
  return v === "allow" || v === "ask" || v === "deny";
}

function cleanPermission(raw: unknown, where: string, onError: OnError): Partial<Record<Surface, unknown>> {
  const out: Partial<Record<Surface, unknown>> = {};
  if (!isPlainObject(raw)) {
    if (raw !== undefined) onError(`permission-mode: permission in ${where} must be an object; ignoring`);
    return out;
  }
  for (const [key, value] of safeEntries(raw)) {
    if (!SURFACES.includes(key as Surface)) {
      onError(`permission-mode: ignoring unknown surface "${key}" in ${where}`);
      continue;
    }
    const surface = key as Surface;
    if (typeof value === "string") {
      if (isAction(value)) {
        out[surface] = value;
      } else {
        onError(`permission-mode: invalid action "${value}" for ${key} in ${where}; treating as deny`);
        out[surface] = "deny";
      }
    } else if (isPlainObject(value)) {
      const map: Record<string, Action> = {};
      for (const [pat, act] of safeEntries(value)) {
        if (/^(0|[1-9]\d*)$/.test(pat)) {
          onError(
            `permission-mode: pattern "${pat}" for ${key} in ${where} is a bare number - JS reorders such keys to the FRONT of the map, so last-match-wins may not follow file order; prefix or quote it differently (e.g. "./${pat}")`,
          );
        }
        if (isAction(act)) {
          map[pat] = act;
        } else {
          onError(`permission-mode: invalid action "${act}" for ${key}.${pat} in ${where}; treating as deny`);
          map[pat] = "deny";
        }
      }
      out[surface] = map;
    } else {
      onError(`permission-mode: ignoring ${key} in ${where}: must be an action or a pattern map`);
    }
  }
  return out;
}

function mergeMode(base: ModeDef, over: Partial<ModeDef>): ModeDef {
  return {
    ...base,
    ...over,
    sandbox: over.sandbox ? { ...base.sandbox, ...over.sandbox } : base.sandbox,
    permission: { ...base.permission, ...(over.permission ?? {}) },
    hideTools: over.hideTools ?? base.hideTools,
  };
}

function warnModeContradictions(name: string, mode: ModeDef, onError: OnError): void {
  if (mode.systemPrompt === PLAN_PROMPT_SENTINEL && mode.hideTools?.includes("show_plan")) {
    onError(
      `permission-mode: mode "${name}" hides show_plan but its "@plan" system prompt tells the model to call it; ` +
        "drop show_plan from hideTools or use a different systemPrompt",
    );
  }
}

function mergeGlobal(base: PermissionModeConfig, over: Partial<PermissionModeConfig>, onError: OnError): PermissionModeConfig {
  const modes: Record<string, ModeDef> = { ...base.modes };
  for (const [name, raw] of modeEntries(over.modes, "global config", onError)) {
    const where = `global mode "${name}"`;
    if (!isPlainObject(raw)) {
      onError(`permission-mode: ${where} must be an object; ignoring`);
      continue;
    }
    const m: Partial<ModeDef> = { ...(raw as Partial<ModeDef>) };
    if (raw.permission !== undefined) m.permission = cleanPermission(raw.permission, where, onError) as ModeDef["permission"];
    if (raw.sandbox !== undefined) m.sandbox = sanitizeSandbox(raw.sandbox, where, onError) as SandboxProfile;
    if (raw.hideTools !== undefined && !isStringArray(raw.hideTools)) {
      onError(`permission-mode: ignoring hideTools in ${where}: must be a string array`);
      delete m.hideTools;
    }
    if (hasMode(modes, name)) {
      modes[name] = mergeMode(modes[name], m);
    } else {
      if (typeof m.label !== "string" || !MODE_COLORS.has(String(m.color)) || !isPlainObject(raw.sandbox)) {
        onError(`permission-mode: ignoring incomplete new global mode "${name}" (needs label, color, sandbox)`);
        continue;
      }
      const sandbox = m.sandbox as Partial<SandboxProfile>;
      if (typeof sandbox.enabled !== "boolean") {
        onError(`permission-mode: ${where}: sandbox.enabled missing; defaulting to true`);
        sandbox.enabled = true;
      }
      if (typeof sandbox.writable !== "boolean") {
        onError(`permission-mode: ${where}: sandbox.writable missing; defaulting to true`);
        sandbox.writable = true;
      }
      if (m.permission === undefined) {
        onError(`permission-mode: ${where}: no permission block; every surface will ask`);
        m.permission = {};
      }
      modes[name] = { ...m, label: m.label, color: m.color as ModeDef["color"], sandbox: sandbox as SandboxProfile, permission: m.permission };
    }
    warnModeContradictions(name, modes[name], onError);
  }
  const cycleOrder = (isStringArray(over.cycleOrder) ? over.cycleOrder : base.cycleOrder).filter((n) => hasMode(modes, n));
  let defaultMode = typeof over.defaultMode === "string" ? over.defaultMode : base.defaultMode;
  if (!hasMode(modes, defaultMode)) defaultMode = cycleOrder[0] ?? base.defaultMode;
  const plan = sanitizePlan(over.plan, onError) ?? base.plan;
  return { defaultMode, cycleOrder, modes, ...(plan ? { plan } : {}) };
}

function sanitizePlan(raw: unknown, onError: OnError): PlanApprovalConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    onError("permission-mode: global config: plan must be an object; ignoring");
    return undefined;
  }
  const out: PlanApprovalConfig = {};
  for (const k of ["approveMode", "approveMessage"] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v === "string") out[k] = v;
    else onError(`permission-mode: global config: plan.${k} must be a string; ignoring`);
  }
  for (const k of Object.keys(raw)) {
    if (k !== "approveMode" && k !== "approveMessage") onError(`permission-mode: global config: unknown key plan.${k}; ignoring`);
  }
  return out;
}

function tightenSandbox(base: SandboxProfile, rawOver: unknown, where: string, onError: OnError): SandboxProfile {
  const over = sanitizeSandbox(rawOver, where, onError);
  const result: SandboxProfile = { ...base, network: { ...base.network } };
  if (over.enabled !== undefined && over.enabled !== base.enabled) {
    onError(`permission-mode: project config cannot change sandbox.enabled; ignoring sandbox.enabled=${over.enabled}`);
  }
  if (over.writable === false) result.writable = false;
  if (over.askOnBlockedHost === false) result.askOnBlockedHost = false;
  if (over.allowWrite !== undefined) result.allowWrite = intersect(base.allowWrite, over.allowWrite);
  if (over.denyRead !== undefined) result.denyRead = union(base.denyRead, over.denyRead);
  if (over.allowRead !== undefined) result.allowRead = intersect(base.allowRead, over.allowRead);
  if (over.denyWrite !== undefined) result.denyWrite = union(base.denyWrite, over.denyWrite);
  if (over.network) {
    if (over.network.allowedDomains !== undefined) {
      const safe = over.network.allowedDomains.filter((d) => {
        if (isUnsafeDomain(d)) {
          onError(`permission-mode: ignoring overly-broad allowedDomains pattern "${d}" in project config`);
          return false;
        }
        return true;
      });
      result.network!.allowedDomains = intersect(base.network?.allowedDomains, safe);
    }
    if (over.network.deniedDomains !== undefined) {
      result.network!.deniedDomains = union(base.network?.deniedDomains, over.network.deniedDomains);
    }
  }
  return result;
}

function applyProject(config: PermissionModeConfig, project: unknown, onError: OnError): void {
  if (!isPlainObject(project)) {
    onError("permission-mode: project config must be a JSON object; ignoring");
    return;
  }
  if (project.defaultMode !== undefined || project.cycleOrder !== undefined) {
    onError("permission-mode: project config cannot change defaultMode/cycleOrder; ignoring");
  }
  if (project.plan !== undefined) {
    onError("permission-mode: project config cannot set plan (approval settings are global); ignoring");
  }
  if (project.modes !== undefined && !isPlainObject(project.modes)) {
    onError("permission-mode: project config modes must be an object; ignoring");
    return;
  }
  for (const [name, raw] of modeEntries(project.modes, "project config", onError)) {
    if (!hasMode(config.modes, name)) {
      onError(`permission-mode: project config cannot add new mode "${name}"; ignoring`);
      continue;
    }
    const where = `project mode "${name}"`;
    try {
      const base = config.modes[name]!;
      if (!isPlainObject(raw)) {
        onError(`permission-mode: ${where} must be an object; ignoring`);
        continue;
      }
      if (raw.sandbox !== undefined) base.sandbox = tightenSandbox(base.sandbox, raw.sandbox, where, onError);
      if (raw.permission !== undefined) {
        base.projectOverlay = cleanPermission(raw.permission, where, onError) as ModeDef["permission"];
      }
    } catch (e) {
      onError(`permission-mode: ignoring ${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function parseConfigFile(p: string, onError: OnError): Partial<PermissionModeConfig> | undefined {
  let size: number;
  try {
    const st = statSync(p);
    if (!st.isFile()) {
      onError(`permission-mode: ${p} is not a regular file; ignoring`);
      return undefined;
    }
    size = st.size;
  } catch {
    return undefined;
  }
  if (size > MAX_CONFIG_BYTES) {
    onError(`permission-mode: ${p} is larger than ${MAX_CONFIG_BYTES} bytes; ignoring`);
    return undefined;
  }
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (!isPlainObject(data)) {
      onError(`permission-mode: ${p} must contain a JSON object; ignoring`);
      return undefined;
    }
    delete data.$schema;
    delete data.$comment;
    return data as Partial<PermissionModeConfig>;
  } catch (e) {
    onError(`permission-mode: could not parse ${p}: ${e}`);
    return undefined;
  }
}

export function stockDefaultsFile(): string {
  return fileURLToPath(new URL("../permission-mode.defaults.json", import.meta.url));
}

export function loadStockDefaults(onError: OnError = noop): PermissionModeConfig {
  const stock = parseConfigFile(stockDefaultsFile(), onError);
  if (!stock) {
    onError("permission-mode: stock defaults (permission-mode.defaults.json) missing or invalid — using minimal fallback; reinstall the extension");
    return clone(FALLBACK_CONFIG);
  }
  return mergeGlobal(clone(FALLBACK_CONFIG), stock, onError);
}

export function globalConfigFile(agentDir: string): string {
  return path.join(agentDir, "permission-mode", "permission-mode.json");
}

export function readGlobalConfigRaw(agentDir: string): Record<string, unknown> | undefined {
  const data = parseConfigFile(globalConfigFile(agentDir), noop) as Record<string, unknown> | undefined;
  if (data) delete data.$comment;
  return data;
}

export function loadModeConfig(cwd: string, agentDir: string, onError: OnError = noop): PermissionModeConfig {
  const projectPath = path.join(cwd, ".pi", "permission-mode.json");

  const config = loadGlobalModeConfig(agentDir, onError);
  const project = parseConfigFile(projectPath, onError);
  if (project) {
    try {
      applyProject(config, project, onError);
    } catch (e) {
      onError(`permission-mode: ignoring project config ${projectPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return config;
}

export function loadGlobalModeConfig(agentDir: string, onError: OnError = noop): PermissionModeConfig {
  let config = loadStockDefaults(onError);
  const global = parseConfigFile(globalConfigFile(agentDir), onError);
  if (global) config = mergeGlobal(config, global, onError);
  return config;
}

function readGlobalForWrite(file: string): Record<string, unknown> {
  if (!existsSync(file)) return { $schema: SCHEMA_URL };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}); fix it before saving a rule`);
  }
  if (!isPlainObject(data)) throw new Error(`${file} must contain a JSON object; fix it before saving a rule`);
  if (data.modes !== undefined && !isPlainObject(data.modes)) throw new Error(`${file}: "modes" must be an object; fix it before saving a rule`);
  return data;
}

export function persistModeDomains(agentDir: string, modeName: string, domains: string[]): string {
  const file = globalConfigFile(agentDir);
  if (UNSAFE_KEYS.has(modeName)) throw new Error(`invalid mode name "${modeName}"`);
  const base = loadGlobalModeConfig(agentDir);
  const baseNetwork = hasMode(base.modes, modeName) ? base.modes[modeName].sandbox.network : undefined;

  const data = readGlobalForWrite(file);
  const modes = (data.modes ??= {}) as Record<string, { sandbox?: { network?: Record<string, unknown> } }>;
  const mode = (modes[modeName] ??= {});
  const sandbox = (mode.sandbox ??= {});
  const network = (sandbox.network ??= {});
  const existing = Array.isArray(network.allowedDomains)
    ? (network.allowedDomains as string[])
    : (baseNetwork?.allowedDomains ?? []);
  network.allowedDomains = [...new Set([...existing, ...domains])];

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

export function persistModeRule(
  agentDir: string,
  modeName: string,
  surface: Surface,
  key: string,
  action: Action,
): string {
  const file = globalConfigFile(agentDir);
  if (UNSAFE_KEYS.has(modeName)) throw new Error(`invalid mode name "${modeName}"`);
  const base = loadGlobalModeConfig(agentDir);
  const basePerm = hasMode(base.modes, modeName) ? base.modes[modeName].permission[surface] : undefined;

  const data = readGlobalForWrite(file);
  const modes = (data.modes ??= {}) as Record<string, { permission?: Record<string, unknown> }>;
  const mode = (modes[modeName] ??= {});
  const perm = (mode.permission ??= {});
  const current = perm[surface] ?? basePerm;

  const map: Record<string, Action> =
    typeof current === "string" ? { "*": current as Action } : isPlainObject(current) ? { ...(current as Record<string, Action>) } : { "*": "ask" };
  map[key] = action;
  perm[surface] = map;

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}
