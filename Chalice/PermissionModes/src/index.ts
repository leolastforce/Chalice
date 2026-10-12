/**
 * Permission Modes extension for Chalice.
 *
 * Integrates declarative sandbox profiles, real tree-sitter bash AST analysis,
 * network allowlisting, and plan approval from pi-permission-modes alongside
 * Chalice's Confirm (isolated workspace review) and Debug modes.
 *
 * Available modes:
 *   - YOLO:    Full permissions, unsandboxed, no backstop (replaces Change/Auto).
 *   - Plan:    Read-only analysis, markdown file writes, show_plan handoff (replaces Think).
 *   - Build:   In-project sandboxed execution without confirmation.
 *   - Confirm: Staged edits in isolated workspace, diff review before commit.
 *   - Debug:   Minimal bug diagnosis and fix workflow, isolated workspace diff review.
 *   - Default: Confirm every bash/edit/write, approved in-project bash runs sandboxed.
 */

import { Type } from "@earendil-works/pi-ai";
import {
  createBashTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { AcceptanceCoordinator, DEBUG_PERMISSIONS_TOOL } from "./acceptance.ts";
import { BlockedPaths, SessionApprovals } from "./approvals.ts";
import { sandboxAwarenessPrompt } from "./awareness.ts";
import {
  auditStaleDefaults,
  defaultsChangedSince,
  describeStale,
  extensionVersion,
  hasGlobalConfig,
  loadDefaultsHistory,
  readAuditState,
  writeAuditState,
} from "./config-audit.ts";
import {
  SCHEMA_URL,
  globalConfigFile,
  hasMode,
  isUnsafeDomain,
  loadModeConfig,
  loadStockDefaults,
  persistModeDomains,
  persistModeRule,
  profileToConfig,
  readGlobalConfigRaw,
  stockDefaultsFile,
} from "./config-load.ts";
import type { PermState } from "./modes.ts";
import { NetworkSession, normalizeDomain } from "./network.ts";
import { canonicalPath, displayPath, normalizeToolPath } from "./paths.ts";
import { restorePendingPlan, sessionBranch } from "./plan-approval.ts";
import { bashExecPlan } from "./bash-enforce.ts";
import { SandboxController, commandFilesDir, networkFiltered, runtimeInstallDir, withDeniedReads } from "./sandbox.ts";
import { ensureScratchDir, scratchBase, scratchBaseOverridden, scratchDirName, sweepScratchDirs, withScratchDir } from "./scratch.ts";
import {
  PLAN_PROMPT_SENTINEL,
  type ModeDef,
  type PermissionModeConfig,
  type SandboxProfile,
  type Surface,
  planModeSystemPrompt,
} from "./schema.ts";
import { createShowPlanTool } from "./show-plan.ts";
import { updateStatus } from "./status.ts";

export type PermissionMode = "yolo" | "plan" | "build" | "confirm" | "debug" | "default";

const EDITING_TOOLS = new Set(["edit", "write"]);

export const MODE_CONTEXT: Record<string, string> = {
  yolo: "[YOLO MODE ACTIVE]\nYou are in YOLO mode. You have full tool access and project edits are applied directly without sandboxing or prompts.",
  plan: "[PLAN MODE ACTIVE]\nYou are in Plan mode. In this mode bash runs read-only and only Markdown files can be created or edited. Call show_plan when your plan is written.",
  build: "[BUILD MODE ACTIVE]\nYou are in Build mode. In-project bash, reads, and writes run sandboxed without confirmation. Out-of-project operations prompt.",
  confirm: "[CONFIRM MODE ACTIVE]\nYou are in Confirm mode. File changes, including changes made by shell commands, are made in an isolated workspace. The original workspace remains unchanged until the user selects Approve Result. Denied or unreviewable results are discarded.",
  debug: `[DEBUG MODE ACTIVE]\nYou are in Debug mode. Reproduce one specific bug, diagnose its cause, propose the minimal fix, and wait for the user's approval before applying it.\n\nEdit and write remain disabled, and bash is restricted to non-mutating commands, until DebugModeImplementingPermissions is called. Once unlocked, changes still go to an isolated workspace and require the final Approve Result / Deny Result decision. Do not fix unrelated issues.`,
  default: "[DEFAULT MODE ACTIVE]\nYou are in Default mode. Confirm every bash, edit, and write. Approved in-project bash runs sandboxed.",
};

export const MODE_MARKERS: Record<string, string> = {
  yolo: "[YOLO MODE ACTIVE]",
  plan: "[PLAN MODE ACTIVE]",
  build: "[BUILD MODE ACTIVE]",
  confirm: "[CONFIRM MODE ACTIVE]",
  debug: "[DEBUG MODE ACTIVE]",
  default: "[DEFAULT MODE ACTIVE]",
};

const ALL_MARKERS = Object.values(MODE_MARKERS);

export function normalizeModeName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const lower = name.trim().toLowerCase();
  if (lower === "change" || lower === "auto") return "yolo";
  if (lower === "think" || lower === "review") return "plan";
  return lower;
}

export default async function permissionModesExtension(pi: ExtensionAPI): Promise<void> {
  let config: PermissionModeConfig = loadStockDefaults();
  let modeName = config.defaultMode;
  let fallbackMode = false;
  let debugImplementingPermissions = false;
  let unrestrictedTools: string[] | undefined;
  const root = process.cwd();

  const currentMode = (): ModeDef =>
    hasMode(config.modes, modeName) ? config.modes[modeName]! : config.modes[config.defaultMode]!;

  let scratchDir: string | undefined;
  const blocked = new BlockedPaths();
  const runtimeProfile = (m: ModeDef): SandboxProfile => withScratchDir(m.sandbox, scratchDir);
  const effectiveSandbox = (m: ModeDef): SandboxProfile => withDeniedReads(runtimeProfile(m), blocked.list());

  const sandbox = new SandboxController();
  const approvals = new SessionApprovals();
  const net = new NetworkSession();
  let uiCtx: ExtensionContext | undefined;

  const coordinator = new AcceptanceCoordinator(
    root,
    approvals,
    net,
    sandbox,
    () => config,
    () => modeName,
    async (next, ctx) => setMode(next, ctx),
    (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
    (type, data) => pi.appendEntry(type, data),
  );

  const localBash = createBashTool(root, {
    spawnHook: (c) => {
      if (!scratchDir) return c;
      const env = { ...c.env, TMPDIR: scratchDir };
      if (process.platform === "win32") Object.assign(env, { TEMP: scratchDir, TMP: scratchDir });
      return { ...c, env };
    },
  });

  const learnForever = (surface: Surface, key: string) => () => {
    try {
      const file = persistModeRule(getAgentDir(), modeName, surface, key, "allow");
      if (uiCtx) {
        config = loadModeConfig(uiCtx.cwd, getAgentDir(), (m) => uiCtx?.ui.notify(m, "warning"));
        uiCtx.ui.notify(`permission-mode: always allow ${surface} "${key}" in ${currentMode().label} — saved to ${file}`, "info");
      }
    } catch (e) {
      uiCtx?.ui.notify(`permission-mode: could not save rule: ${e}`, "error");
    }
  };

  function captureAvailableTools(): void {
    if (unrestrictedTools === undefined) {
      unrestrictedTools = pi.getActiveTools().filter((toolName) => toolName !== DEBUG_PERMISSIONS_TOOL);
    }
  }

  function toolsForMode(nextMode: string): string[] {
    const available = (unrestrictedTools ?? pi.getActiveTools()).filter(
      (toolName) => toolName !== DEBUG_PERMISSIONS_TOOL,
    );
    if (nextMode === "debug") {
      const base = debugImplementingPermissions
        ? available
        : available.filter((toolName) => !EDITING_TOOLS.has(toolName));
      return [...base, DEBUG_PERMISSIONS_TOOL];
    }
    const hide = new Set(config.modes[nextMode]?.hideTools ?? []);
    return available.filter((name) => !hide.has(name));
  }

  function applyToolVisibility(): void {
    const desired = toolsForMode(modeName);
    const current = pi.getActiveTools();
    if (desired.length !== current.length || desired.some((name, i) => name !== current[i])) {
      pi.setActiveTools(desired);
    }
  }

  const setMode = async (name: string, ctx: ExtensionContext, persist = true, viaFallback = false): Promise<void> => {
    const target = normalizeModeName(name);
    if (!target || !hasMode(config.modes, target)) return;
    captureAvailableTools();
    uiCtx = ctx;
    const previous = modeName;
    modeName = target;
    fallbackMode = viaFallback;
    if (modeName !== "debug") debugImplementingPermissions = false;

    if (!viaFallback) process.env.PI_PERMISSION_MODE = modeName;
    const m = currentMode();
    await sandbox.applyProfile(runtimeProfile(m));
    applyToolVisibility();
    updateStatus(ctx, m, sandbox, net.open);
    pi.events.emit("chalice:mode-state", modeName);
    ctx.ui.notify(`Permission mode: ${m.label}`, "info");

    if (persist) {
      pi.appendEntry<PermState>("permission-mode", {
        mode: modeName,
        debugImplementingPermissions,
      });
      pi.appendEntry<PermState>("perm-mode", { mode: modeName });
    }

    if (persist && previous !== modeName) {
      await coordinator.checkManualModeSwitchPlanPrompt(modeName, ctx);
    }
  };

  function grantDebugImplementingPermissions(ctx: ExtensionContext): void {
    debugImplementingPermissions = true;
    if (unrestrictedTools === undefined) {
      unrestrictedTools = pi.getAllTools()
        .map((tool) => tool.name)
        .filter((toolName) => toolName !== DEBUG_PERMISSIONS_TOOL);
    }
    applyToolVisibility();
    updateStatus(ctx, currentMode(), sandbox, net.open);
    pi.appendEntry<PermState>("permission-mode", {
      mode: modeName,
      debugImplementingPermissions: true,
    });
  }

  const cycle = async (ctx: ExtensionContext): Promise<void> => {
    const order = config.cycleOrder;
    const idx = order.indexOf(modeName);
    const next = order[(idx + 1) % order.length]!;
    await setMode(next, ctx);
  };

  const pickMode = (ctx: ExtensionContext, useFlag: boolean): { name: string; fallback: boolean } => {
    let resolved: string | undefined;
    if (useFlag) {
      const flag = normalizeModeName(pi.getFlag("perm") || pi.getFlag("permission-mode"));
      if (flag && hasMode(config.modes, flag)) resolved = flag;
    }
    if (!resolved) {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom") {
          if (entry.customType === "permission-mode" || entry.customType === "perm-mode") {
            const data = entry.data as PermState | undefined;
            const normalized = normalizeModeName(data?.mode);
            if (normalized && hasMode(config.modes, normalized)) {
              resolved = normalized;
              if (normalized === "debug" && data?.debugImplementingPermissions === true) {
                debugImplementingPermissions = true;
              }
            }
          }
        }
      }
    }
    if (!resolved) {
      const env = normalizeModeName(process.env.PI_PERMISSION_MODE);
      if (env && hasMode(config.modes, env)) resolved = env;
    }
    if (!resolved && !ctx.hasUI) return { name: "default", fallback: true };
    return { name: resolved ?? modeName, fallback: false };
  };

  const networkEnforcing = () => sandbox.ready && networkFiltered(currentMode().sandbox);

  const toggleNetwork = async (ctx: ExtensionContext): Promise<void> => {
    uiCtx = ctx;
    if (!networkEnforcing()) {
      return ctx.ui.notify("permission-mode: network is not filtered in this mode/state — nothing to toggle", "info");
    }
    net.open = !net.open;
    updateStatus(ctx, currentMode(), sandbox, net.open);
    ctx.ui.notify(
      net.open
        ? "Network: OPEN for this session — domain filtering disabled (alt+n to re-enable)"
        : "Network: filtered — domain allowlist active",
      net.open ? "warning" : "info",
    );
  };

  pi.registerFlag("perm", {
    description: `Start in permission mode: ${config.cycleOrder.join(" | ")}`,
    type: "string",
    default: "",
  });
  pi.registerFlag("permission-mode", {
    description: `Start in permission mode: ${config.cycleOrder.join(" | ")}`,
    type: "string",
    default: "",
  });
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for the sandboxed modes",
    type: "boolean",
    default: false,
  });

  pi.registerShortcut("alt+m", {
    description: `Cycle permission mode (${config.cycleOrder.join(" -> ")})`,
    handler: async (ctx) => cycle(ctx),
  });

  pi.registerShortcut("alt+n", {
    description: "Toggle network filtering for this session (filtered <-> open)",
    handler: toggleNetwork,
  });

  const handleModeCommand = async (args: string, ctx: ExtensionContext) => {
    const raw = args.trim().toLowerCase();
    const sub = raw.split(/\s+/, 1)[0] ?? "";
    if (!sub) {
      return ctx.ui.notify(`Permission mode: ${modeName}. Available: ${config.cycleOrder.join(", ")}.`, "info");
    }
    if (sub === "clear-approvals") {
      approvals.clearAll();
      blocked.clear();
      return ctx.ui.notify("permission-mode: cleared session approvals and blocked paths", "info");
    }
    if (sub === "blocks") {
      const list = blocked.list();
      return ctx.ui.notify(
        list.length ? `permission-mode: blocked paths:\n${list.map((b) => `  - ${displayPath(b)}`).join("\n")}` : "permission-mode: no blocked paths",
        "info",
      );
    }
    if (sub === "unblock" || sub.startsWith("unblock ")) {
      const targetPath = raw.slice("unblock".length).trim();
      if (!targetPath) return ctx.ui.notify("permission-mode: usage: /mode unblock <path>", "warning");
      const target = canonicalPath(root, normalizeToolPath(targetPath));
      if (!blocked.remove(target)) return ctx.ui.notify(`permission-mode: ${displayPath(target)} is not blocked`, "warning");
      return ctx.ui.notify(`permission-mode: ${displayPath(target)} is readable again`, "info");
    }
    if (sub === "init") {
      const dest = globalConfigFile(getAgentDir());
      return ctx.ui.notify(`permission-mode: global config path is ${dest}`, "info");
    }

    const normalized = normalizeModeName(sub);
    if (normalized && hasMode(config.modes, normalized)) {
      await setMode(normalized, ctx);
      return;
    }
    ctx.ui.notify(`Unknown mode "${sub}". Available: ${config.cycleOrder.join(", ")}.`, "error");
  };

  pi.registerCommand("mode", {
    description: `Set or cycle permission mode: /mode [${config.cycleOrder.join("|")}]`,
    getArgumentCompletions: (prefix) =>
      config.cycleOrder
        .filter((candidate) => candidate.startsWith(prefix.trim().toLowerCase()))
        .map((name) => ({ value: name, label: name })),
    handler: handleModeCommand,
  });

  pi.registerCommand("perm", {
    description: `Set or cycle permission mode: /perm [${config.cycleOrder.join("|")}]`,
    getArgumentCompletions: (prefix) =>
      config.cycleOrder
        .filter((candidate) => candidate.startsWith(prefix.trim().toLowerCase()))
        .map((name) => ({ value: name, label: name })),
    handler: handleModeCommand,
  });

  pi.registerCommand("plan", {
    description: "Plan approval: /plan approve | /plan status",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "approve") {
        if (!coordinator.currentPendingPlan) {
          return ctx.ui.notify("permission-mode: no plan pending", "warning");
        }
        await coordinator.approvePlan(ctx);
        return;
      }
      if (arg === "" || arg === "status") {
        return ctx.ui.notify(
          coordinator.currentPendingPlan ? `permission-mode: pending plan: ${coordinator.currentPendingPlan.path}` : "permission-mode: no plan pending",
          "info",
        );
      }
      ctx.ui.notify("permission-mode: usage: /plan approve | status", "warning");
    },
  });

  pi.registerCommand("net", {
    description: "Network sandbox: /net [status|allow <domain…>|open|restrict|reset]",
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const m = currentMode();
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "status").toLowerCase();
      if (sub === "open") {
        if (!net.open) return toggleNetwork(ctx);
        return ctx.ui.notify("permission-mode: network is already open", "info");
      }
      if (sub === "restrict") {
        if (net.open) return toggleNetwork(ctx);
        return ctx.ui.notify("permission-mode: network filtering is already active", "info");
      }
      if (sub === "reset") {
        net.clear();
        updateStatus(ctx, m, sandbox, net.open);
        return ctx.ui.notify("permission-mode: cleared network grants/denies", "info");
      }
      if (sub === "allow") {
        const domains = [...new Set(parts.slice(1).map(normalizeDomain).filter((d): d is string => d !== undefined))];
        const safe = domains.filter((d) => !isUnsafeDomain(d));
        if (safe.length === 0) {
          return ctx.ui.notify("permission-mode: usage: /net allow <domain>", "warning");
        }
        net.grant(safe);
        return ctx.ui.notify(`permission-mode: allowed for session: ${safe.join(", ")}`, "info");
      }
      ctx.ui.notify(`Network (${m.label}): ${net.open ? "open" : "filtered"}`, "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox status and configuration",
    handler: async (_args, ctx) => {
      const m = currentMode();
      if (!m.sandbox.enabled) {
        return ctx.ui.notify(`${m.label}: sandbox disabled for this mode`, "info");
      }
      if (sandbox.disabled) return ctx.ui.notify("Sandbox disabled via --no-sandbox", "info");
      if (!sandbox.ready) return ctx.ui.notify(`Sandbox unavailable: ${sandbox.warn ?? "unknown"}`, "warning");
      const c = profileToConfig(effectiveSandbox(m));
      ctx.ui.notify(`Sandbox: ACTIVE for ${m.label}\nWritable: ${c.filesystem.allowWrite.join(", ")}`, "info");
    },
  });

  pi.registerTool({
    name: DEBUG_PERMISSIONS_TOOL,
    label: "Debug Implementing Permissions",
    description:
      "Unlock edit and write tools plus unrestricted bash in Debug mode once the minimal fix is approved.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (modeName !== "debug") {
        return {
          content: [{ type: "text", text: "DebugModeImplementingPermissions is only available in Debug mode." }],
          details: { granted: false },
        };
      }
      if (debugImplementingPermissions) {
        return {
          content: [{ type: "text", text: "Implementation permissions are already granted." }],
          details: { granted: true },
        };
      }
      grantDebugImplementingPermissions(ctx);
      return {
        content: [{ type: "text", text: "Implementation permissions granted for Debug mode." }],
        details: { granted: true },
      };
    },
  });

  pi.registerTool(createShowPlanTool(root));

  pi.registerTool({
    name: "request_network_access",
    label: "Request network access",
    promptSnippet: "Ask the user to allow bash network access to domains outside the sandbox allowlist",
    description: "Ask the user to allow bash network access to one or more domains outside the sandbox allowlist.",
    parameters: Type.Object({
      domains: Type.Array(Type.String({ description: "Domain or subdomain wildcard" })),
      reason: Type.String({ description: "One short line: why access is needed" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return coordinator.handleRequestNetworkAccess(
        params as { domains?: string[]; reason?: string },
        ctx ?? uiCtx!,
        {
          mode: currentMode(),
          isNetworkFiltered: networkFiltered(currentMode().sandbox),
          onForever: async (domains) => {
            persistModeDomains(getAgentDir(), modeName, domains);
          },
        },
      );
    },
  });


  pi.events.on("chalice:mode", async (value) => {
    const nextMode = normalizeModeName(value);
    if (!nextMode) return;
    if (uiCtx) {
      await setMode(nextMode, uiCtx);
    } else {
      modeName = nextMode;
      applyToolVisibility();
      pi.events.emit("chalice:mode-state", modeName);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    try {
      config = loadModeConfig(ctx.cwd, getAgentDir(), (m) => ctx.ui.notify(m, "warning"));
    } catch {
      // keep existing
    }
    if (!hasMode(config.modes, modeName)) modeName = config.defaultMode;
    const picked = pickMode(ctx, true);
    modeName = picked.name;
    coordinator.setPendingPlan(restorePendingPlan(sessionBranch(ctx)));

    const base = scratchBase();
    const dir = path.join(base, scratchDirName(ctx.sessionManager.getSessionId?.()));
    if (ensureScratchDir(dir, { sharedBase: !scratchBaseOverridden() })) {
      scratchDir = dir;
      process.env.CLAUDE_CODE_TMPDIR = dir;
      process.env.CLAUDE_TMPDIR = dir;
      sweepScratchDirs(base, dir);
    }

    await sandbox.init({
      cwd: ctx.cwd,
      noSandbox: pi.getFlag("no-sandbox") === true,
      hasUI: ctx.hasUI,
      notify: (m) => ctx.ui.notify(m, "warning"),
      profile: runtimeProfile(currentMode()),
      askHost: (host, port) =>
        net.decide(host, port, (h, p) =>
          coordinator.handleLiveNetworkAsk(h, p, uiCtx, async (d) => {
            persistModeDomains(getAgentDir(), modeName, [d]);
          }),
        ),
    });

    if (sandbox.ready) {
      pi.registerTool({
        name: "bash",
        label: "Bash",
        description: "Run a sandboxed shell command",
        parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
        async execute(id, params, signal, onUpdate, execCtx) {
          const execCwd = execCtx?.cwd ?? ctx.cwd ?? root;
          const approved = coordinator.consumeApprovedUnsandboxed(id);
          const m = currentMode();
          const plan = bashExecPlan(m.sandbox.enabled, m.sandbox.writable, sandbox.ready, approved);
          const ops = plan.sandboxed
            ? sandbox.bashOps({
                readOnly: plan.readOnly,
                keepWritable: scratchDir ? [scratchDir] : [],
                extraDenyRead: blocked.list(),
                tmpdir: scratchDir,
              })
            : null;
          const bash = createBashTool(execCwd, { operations: ops ?? undefined });
          return bash.execute(id, params, signal, onUpdate);
        },
      });
    }

    await setMode(picked.name, ctx, false, picked.fallback);
  });

  pi.on("session_tree", async (_event, ctx) => {
    uiCtx = ctx;
    await coordinator.discardWorkspace(ctx);
    coordinator.setPendingPlan(restorePendingPlan(sessionBranch(ctx)));
    const picked = pickMode(ctx, false);
    await setMode(picked.name, ctx, false, picked.fallback);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    approvals.clearAll();
    blocked.clear();
    net.clear();
    coordinator.setPendingPlan(undefined);
    await coordinator.discardWorkspace(ctx);
    await sandbox.reset();
  });

  pi.on("agent_start", () => {
    coordinator.onAgentRunStart();
  });

  pi.on("agent_end", async (_event, ctx) => {
    await coordinator.offerPlanApproval(ctx, currentMode());
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await coordinator.onAgentSettled(ctx);
  });

  pi.on("tool_execution_end", (event) => {
    coordinator.onToolExecutionEnd(
      event.toolCallId,
      event.isError,
      event.result,
      currentMode().systemPrompt === PLAN_PROMPT_SENTINEL,
    );
  });

  pi.on("tool_call", async (event, ctx) => {
    uiCtx = ctx;
    const m = currentMode();
    const decision = await coordinator.evaluateToolCall(event, ctx, {
      mode: m,
      debugImplementingPermissions,
      effectiveSandbox: effectiveSandbox(m),
      blocked,
      learnForever,
    });
    return decision;
  });

  pi.on("before_agent_start", async (event) => {
    applyToolVisibility();
    const m = currentMode();
    const parts: string[] = [];

    const aware = sandboxAwarenessPrompt(
      { ...m, sandbox: effectiveSandbox(m) },
      {
        active: sandbox.ready && !sandbox.disabled,
        reason: sandbox.disabled ? "disabled via --no-sandbox" : sandbox.warn,
        networkOpen: net.open,
        sessionDomains: net.grants(),
        scratchDir,
      },
    );
    if (aware) parts.push(aware);

    const sp = m.systemPrompt;
    if (sp && !fallbackMode) {
      parts.push(sp === PLAN_PROMPT_SENTINEL ? planModeSystemPrompt(new Date().toISOString().slice(0, 10)) : sp);
    }

    event.systemPromptOptions.selectedTools = toolsForMode(modeName);

    return {
      systemPrompt: parts.length > 0 ? [event.systemPrompt, ...parts].join("\n\n") : undefined,
      message: {
        customType: "permission-mode-context",
        content: MODE_CONTEXT[modeName] ?? `[${modeName.toUpperCase()} MODE ACTIVE]`,
        display: false,
      },
    };
  });

  pi.on("context", async (event) => {
    const currentMarker = MODE_MARKERS[modeName] ?? `[${modeName.toUpperCase()} MODE ACTIVE]`;
    const staleMarkers = ALL_MARKERS.filter((marker) => marker !== currentMarker);
    let foundCurrent = false;

    const messages = event.messages.filter((message) => {
      const msg = message as { customType?: string; content?: unknown };
      if (msg.customType !== "permission-mode-context") return true;
      const content = typeof msg.content === "string" ? msg.content : undefined;
      if (content === undefined) return true;
      if (staleMarkers.some((marker) => content.includes(marker))) return false;
      if (content.includes(currentMarker)) foundCurrent = true;
      return true;
    });

    if (!foundCurrent) {
      messages.push({
        role: "custom",
        customType: "permission-mode-context",
        content: MODE_CONTEXT[modeName] ?? `[${modeName.toUpperCase()} MODE ACTIVE]`,
        display: false,
      } as typeof messages[number]);
    }
    return { messages };
  });
}
