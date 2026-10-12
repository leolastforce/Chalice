/**
 * Acceptance & Approval Architecture
 *
 * Central coordinator for how and when operations are evaluated,
 * gated, staged, and accepted across permission modes.
 *
 * Surfaces governed:
 *   1. Pre-execution Tool Call Acceptance (allow, ask/prompt, block, or isolate)
 *   2. Command & Bash Acceptance (AST analysis, sandbox enforcement, privilege/escape gating, safe command check)
 *   3. Network Domain Acceptance (session grants, live user ask, domain persistence)
 *   4. Post-execution Turn Settled Acceptance:
 *      - Staged Workspace Diff Review (Confirm & Debug modes -> interactive review & commit/discard)
 *      - Plan Review & Handoff (Plan mode -> show_plan result acceptance & transition to Build)
 */

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { showResultApproval } from "./approval-ui.ts";
import { type DenyOption, SessionApprovals, askWithSession } from "./approvals.ts";
import { bashExecPlan, bashGate } from "./bash-enforce.ts";
import { analyzeBash, escapeTargetFromReason, escapingPaths } from "./bash-parse.ts";
import {
  type NetAskResult,
  NetworkSession,
  isHostAllowed,
  normalizeDomain,
} from "./network.ts";
import {
  blockablePath,
  canonicalPath,
  displayPath,
  isOutside,
  isProtectedWrite,
  normalizeToolPath,
  resolvePlanPath,
  sandboxAllowedRoots,
} from "./paths.ts";
import {
  DEFAULT_APPROVE_MODE,
  PLAN_ENTRY,
  type PendingPlan,
  type PlanEntry,
  approvalMessage,
  planHash,
  SAFE_PLAN_PATH,
  shownPlanPath,
} from "./plan-approval.ts";
import { decide, decideBashChain } from "./resolve.ts";
import type { SandboxController } from "./sandbox.ts";
import type { Action, ModeDef, PermissionModeConfig, Surface } from "./schema.ts";
import { updateStatus } from "./status.ts";
import { ConfirmWorkspace, WorkspaceConflictError } from "./workspace.ts";

export const DEBUG_PERMISSIONS_TOOL = "DebugModeImplementingPermissions";

const DEBUG_MUTATION_PATTERNS = [
  /(?:^|[\s;&|])(?:\d*)>>?/,
  /\b(?:rm|rmdir|mv|cp|mkdir|touch|tee|truncate|install|unlink|ln)\b/i,
  /\b(?:chmod|chown|chgrp|setfacl)\b/i,
  /\b(?:sed|perl)\s+[^\n]*\s-i(?:\s|$)/i,
  /\bgit\s+(?:add|commit|clean|checkout|reset|merge|rebase|cherry-pick|revert|stash|apply|restore|switch)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|remove|update|uninstall|link|publish)\b/i,
  /\b(?:node|bun|deno|python(?:\d+)?|python3|ruby|perl)\s+(?:-[ec]|--eval|--execute)\b/i,
] as const;

export function isDebugSafeBashCommand(command: string): boolean {
  return !DEBUG_MUTATION_PATTERNS.some((pattern) => pattern.test(command));
}

const FILE_TOOL_SURFACE: Record<string, Surface> = {
  read: "read",
  edit: "edit",
  write: "write",
  ls: "ls",
  grep: "grep",
  find: "find",
};

const READ_ONLY_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  anchor_grep: true,
  find: true,
  ls: true,
};

export interface ToolCallDecision {
  block?: boolean;
  terminate?: boolean;
  reason?: string;
}

export class AcceptanceCoordinator {
  private workspace?: ConfirmWorkspace;
  private workspaceFailure?: string;
  private approvedUnsandboxed = new Set<string>();
  private planCalls = new Map<string, string>();
  private pendingPlan?: PendingPlan;
  private planShownThisRun = false;
  private planPrompting = false;
  private approvingPlan = false;
  private approveModeWarned = false;
  private readonly root: string;
  private readonly approvals: SessionApprovals;
  private readonly net: NetworkSession;
  private readonly sandbox: SandboxController;
  private readonly getConfig: () => PermissionModeConfig;
  private readonly getModeName: () => string;
  private readonly setMode: (name: string, ctx: ExtensionContext) => Promise<void>;
  private readonly sendFollowUp: (text: string) => void;
  private readonly appendSessionEntry: <T>(customType: string, data: T) => void;

  constructor(
    root: string,
    approvals: SessionApprovals,
    net: NetworkSession,
    sandbox: SandboxController,
    getConfig: () => PermissionModeConfig,
    getModeName: () => string,
    setMode: (name: string, ctx: ExtensionContext) => Promise<void>,
    sendFollowUp: (text: string) => void,
    appendSessionEntry: <T>(customType: string, data: T) => void,
  ) {
    this.root = root;
    this.approvals = approvals;
    this.net = net;
    this.sandbox = sandbox;
    this.getConfig = getConfig;
    this.getModeName = getModeName;
    this.setMode = setMode;
    this.sendFollowUp = sendFollowUp;
    this.appendSessionEntry = appendSessionEntry;
  }
  get activeWorkspace(): ConfirmWorkspace | undefined {
    return this.workspace;
  }

  get currentPendingPlan(): PendingPlan | undefined {
    return this.pendingPlan;
  }

  setPendingPlan(plan: PendingPlan | undefined): void {
    this.pendingPlan = plan;
  }

  onAgentRunStart(): void {
    this.planShownThisRun = false;
  }

  recordPlanCall(toolCallId: string, filePath: string): void {
    this.planCalls.set(toolCallId, resolvePlanPath(filePath));
  }

  onToolExecutionEnd(toolCallId: string, isError: boolean, result: unknown, isPlanningPrompt: boolean): void {
    this.approvedUnsandboxed.delete(toolCallId);
    const requested = this.planCalls.get(toolCallId);
    if (requested === undefined) return;
    this.planCalls.delete(toolCallId);

    const details = (result as { details?: { error?: unknown; path?: unknown } } | undefined)?.details;
    const hasError = isError || Boolean(details && typeof details === "object" && details.error);
    if (hasError || !isPlanningPrompt) return;

    const planPath = shownPlanPath(result, requested);
    if (!SAFE_PLAN_PATH.test(planPath)) return;
    const sha = planHash(this.root, planPath);
    this.pendingPlan = { path: planPath, declined: false, ...(sha ? { sha } : {}) };
    this.planShownThisRun = true;
    this.appendSessionEntry<PlanEntry>(PLAN_ENTRY, { path: planPath, ...(sha ? { sha } : {}) });
  }

  consumeApprovedUnsandboxed(id: string): boolean {
    return this.approvedUnsandboxed.delete(id);
  }

  async startWorkspace(ctx: ExtensionContext): Promise<void> {
    if (this.workspace || this.workspaceFailure) return;
    try {
      this.workspace = await ConfirmWorkspace.create(ctx.cwd);
      ctx.setExecutionCwdOverride?.(this.workspace.workingDirectory);
    } catch (error) {
      this.workspaceFailure = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) {
        ctx.ui.notify(`Could not create an isolated workspace: ${this.workspaceFailure}`, "error");
      }
    }
  }

  async discardWorkspace(ctx: ExtensionContext): Promise<void> {
    const current = this.workspace;
    this.workspace = undefined;
    this.workspaceFailure = undefined;
    ctx.setExecutionCwdOverride?.(undefined);
    if (current) await current.discard();
  }

  private approveModeName(): string {
    return this.getConfig().plan?.approveMode ?? DEFAULT_APPROVE_MODE;
  }

  private approveModeDef(ctx: ExtensionContext): ModeDef | undefined {
    const target = this.approveModeName();
    const config = this.getConfig();
    if (target in config.modes) return config.modes[target];
    if (!this.approveModeWarned) {
      this.approveModeWarned = true;
      ctx.ui.notify(
        `permission-mode: plan.approveMode "${target}" is not a defined mode; plan approval is off until it is fixed`,
        "warning",
      );
    }
    return undefined;
  }

  async approvePlan(ctx: ExtensionContext): Promise<boolean> {
    const plan = this.pendingPlan;
    if (!plan || !this.approveModeDef(ctx)) return false;
    if (plan.sha && planHash(this.root, plan.path) !== plan.sha) {
      ctx.ui.notify(`permission-mode: ${plan.path} changed since it was shown; ask for show_plan again before approving`, "warning");
      return false;
    }
    const target = this.approveModeName();
    this.approvingPlan = true;
    try {
      if (this.getModeName() !== target) await this.setMode(target, ctx);
    } finally {
      this.approvingPlan = false;
    }
    this.pendingPlan = undefined;
    this.appendSessionEntry<PlanEntry>(PLAN_ENTRY, {});
    const msg = approvalMessage(this.getConfig().plan?.approveMessage, plan.path);
    this.sendFollowUp(msg);
    return true;
  }

  async offerPlanApproval(ctx: ExtensionContext, currentMode: ModeDef): Promise<void> {
    const plan = this.pendingPlan;
    if (!plan || plan.declined || this.planPrompting || !ctx.hasUI) return;
    const target = this.approveModeDef(ctx);
    if (!target) return;
    this.planPrompting = true;
    try {
      const accept = `Accept: switch to ${target.label} and implement it`;
      const decline = `Decline: keep refining in ${currentMode.label}`;
      const choice = await ctx.ui.select(`Plan ready: ${plan.path}`, [accept, decline]);
      if (choice === accept) {
        await this.approvePlan(ctx);
      } else {
        plan.declined = true;
      }
    } finally {
      this.planPrompting = false;
    }
  }

  async checkManualModeSwitchPlanPrompt(nextMode: string, ctx: ExtensionContext): Promise<void> {
    if (this.pendingPlan && !this.approvingPlan && ctx.hasUI && nextMode === this.approveModeName()) {
      const plan = this.pendingPlan;
      const yes = await ctx.ui.confirm(
        `Implement ${plan.path} now?`,
        `Yes sends the approval message to the model. No leaves you in ${nextMode} with nothing sent (/plan approve later).`,
      );
      if (yes) await this.approvePlan(ctx);
    }
  }

  private promptAllow(
    ctx: ExtensionContext,
    surface: Surface,
    target: string | string[],
    title: string,
    onForever?: () => void | Promise<void>,
    denyAnd?: DenyOption,
  ): Promise<boolean> {
    return askWithSession(
      { hasUI: ctx.hasUI, select: (t, o) => ctx.ui.select(t, o) },
      this.approvals,
      this.getModeName(),
      surface,
      target,
      title,
      onForever,
      denyAnd,
    );
  }

  private denyAndBlock(
    ctx: ExtensionContext,
    targets: readonly string[],
    effectiveSandbox: ModeDef["sandbox"],
    blocked: { covers(p: string): boolean; add(p: string): void },
  ): DenyOption | undefined {
    const eligible = [
      ...new Set(
        targets
          .map((t) =>
            blockablePath(this.root, t, {
              alsoInside: effectiveSandbox.allowWrite ?? [],
              denyRead: effectiveSandbox.denyRead ?? [],
              allowRead: effectiveSandbox.allowRead ?? [],
            }),
          )
          .filter((t): t is string => t !== undefined && !blocked.covers(t)),
      ),
    ];
    if (eligible.length === 0) return undefined;
    const shown = eligible.map(displayPath).join(", ");
    return {
      label: `Deny and block ${shown} for this session`,
      run: async () => {
        for (const t of eligible) blocked.add(t);
        updateStatus(ctx, this.getConfig().modes[this.getModeName()]!, this.sandbox, this.net.open);
        ctx.ui.notify(
          `permission-mode: ${shown} is now unreadable inside the sandbox for this session (/perm blocks to list)`,
          "info",
        );
      },
    };
  }

  async evaluateToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
    opts: {
      mode: ModeDef;
      debugImplementingPermissions: boolean;
      effectiveSandbox: ModeDef["sandbox"];
      blocked: { covers(p: string): boolean; add(p: string): void };
      learnForever?: (surface: Surface, key: string) => () => void;
    },
  ): Promise<ToolCallDecision | undefined> {
    const { toolName } = event;
    const modeName = this.getModeName();
    const { mode, debugImplementingPermissions, effectiveSandbox, blocked, learnForever } = opts;

    if (toolName === DEBUG_PERMISSIONS_TOOL) {
      if (modeName === "debug") return undefined;
      return {
        block: true,
        terminate: true,
        reason: "DebugModeImplementingPermissions is only available in Debug mode. Do not retry this call.",
      };
    }

    if (modeName === "debug" && !debugImplementingPermissions) {
      if (toolName === "edit" || toolName === "write") {
        return {
          block: true,
          terminate: true,
          reason: "Debug mode: edit and write are disabled until the fix is approved and DebugModeImplementingPermissions is called.",
        };
      }
      if (toolName === "bash") {
        const input = event.input as Record<string, unknown>;
        const command = typeof input.command === "string" ? input.command : "";
        if (!isDebugSafeBashCommand(command)) {
          return {
            block: true,
            terminate: true,
            reason: "Debug mode: bash is restricted to non-mutating commands until the fix is approved and DebugModeImplementingPermissions is called.",
          };
        }
      }
    }

    const requiresWorkspaceIsolation =
      this.workspace !== undefined ||
      this.workspaceFailure !== undefined ||
      modeName === "confirm" ||
      modeName === "debug";

    if (requiresWorkspaceIsolation && !READ_ONLY_TOOLS[toolName]) {
      if (this.workspaceFailure) {
        return {
          block: true,
          terminate: true,
          reason: `The isolated workspace could not be created: ${this.workspaceFailure}. No project changes were run.`,
        };
      }
      await this.startWorkspace(ctx);
      if (this.workspaceFailure) {
        return {
          block: true,
          terminate: true,
          reason: `The isolated workspace could not be created: ${this.workspaceFailure}. No project changes were run.`,
        };
      }
    }

    const input = event.input as Record<string, unknown>;
    if (toolName === "show_plan" && typeof input.path === "string") {
      this.recordPlanCall(event.toolCallId, input.path);
    }

    const inPath = typeof input.path === "string" ? normalizeToolPath(input.path) : undefined;
    if (inPath !== undefined && inPath.includes("\0")) {
      return { block: true, terminate: true, reason: "Path contains a NUL byte" };
    }

    const bounds = sandboxAllowedRoots(this.root, effectiveSandbox);

    if (!mode.bypassProtectedPaths && (toolName === "edit" || toolName === "write") && inPath !== undefined) {
      if (isProtectedWrite(this.root, inPath)) {
        if (ctx.hasUI) ctx.ui.notify(`Blocked write to protected path: ${inPath}`, "warning");
        return { block: true, terminate: true, reason: `Path "${inPath}" is protected` };
      }
    }

    if (toolName === "bash") {
      const command = String(input.command ?? "");
      if (!mode.sandbox.enabled) {
        const gate = bashGate(decide(mode, "bash", command), undefined, false, this.sandbox.ready);
        if (gate.kind === "block") return { block: true, terminate: true, reason: gate.reason };
        if (gate.kind === "prompt") {
          if (!(await this.promptAllow(ctx, "bash", command, gate.title))) {
            return { block: true, terminate: true, reason: gate.reason };
          }
          if (gate.onApproveUnsandboxed) this.approvedUnsandboxed.add(event.toolCallId);
        }
        return undefined;
      }

      const analysis = await analyzeBash(command, this.root, bounds);
      const action: Action =
        analysis.commands.length > 0 ? decideBashChain(mode, analysis.commands) : decide(mode, "bash", command);
      const gate = bashGate(action, analysis.outsideReason, mode.sandbox.enabled, this.sandbox.ready);
      if (gate.kind === "block") return { block: true, terminate: true, reason: gate.reason };
      if (gate.kind === "prompt") {
        const names = [...new Set(analysis.commands.map((c) => c.name).filter(Boolean))];
        const keys = analysis.outsideReason ? [`escape:${command}`] : names.length > 0 ? names : [command];
        const targets = analysis.outsideReason?.startsWith("path outside project")
          ? analysis.usedFallback
            ? [escapeTargetFromReason(analysis.outsideReason, this.root)].filter((t): t is string => t !== undefined)
            : escapingPaths(analysis.commands, this.root, bounds)
          : [];
        const hit = targets.map((t) => canonicalPath(this.root, t)).find((t) => blocked.covers(t));
        if (hit) return { block: true, terminate: true, reason: `Path ${displayPath(hit)} is blocked for this session` };
        const denyAnd = this.denyAndBlock(ctx, targets, effectiveSandbox, blocked);
        if (!(await this.promptAllow(ctx, "bash", keys, gate.title, undefined, denyAnd))) {
          return { block: true, terminate: true, reason: gate.reason };
        }
        if (gate.onApproveUnsandboxed) this.approvedUnsandboxed.add(event.toolCallId);
      }
      return undefined;
    }

    const surface = FILE_TOOL_SURFACE[toolName];
    if (surface && inPath !== undefined) {
      if (blocked.covers(canonicalPath(this.root, inPath))) {
        return { block: true, terminate: true, reason: `Path "${inPath}" is blocked for this session` };
      }
      const outside = isOutside(this.root, inPath, bounds);
      const action = decide(mode, surface, inPath, { isOutside: outside });
      if (action === "deny") {
        if ((surface === "edit" || surface === "write") && !mode.sandbox.writable) {
          if (ctx.hasUI) ctx.ui.notify(`${mode.label} allows editing Markdown files only: ${inPath}`, "warning");
          return { block: true, terminate: true, reason: `${mode.label} allows editing Markdown files only` };
        }
        return { block: true, terminate: true, reason: `Path "${inPath}" is blocked by ${mode.label}` };
      }
      if (action === "ask") {
        const title = outside ? `Outside project - allow ${toolName}? (${inPath})` : `Allow ${toolName}? (${inPath})`;
        const denyAnd = outside ? this.denyAndBlock(ctx, [inPath], effectiveSandbox, blocked) : undefined;
        if (!(await this.promptAllow(ctx, surface, inPath, title, undefined, denyAnd))) {
          return { block: true, terminate: true, reason: outside ? "Access outside project blocked" : "blocked" };
        }
      }
      return undefined;
    }

    if (toolName === "web_search") {
      const action = decide(mode, "web_search", String(input.query ?? "(empty)"));
      if (action === "deny") return { block: true, terminate: true, reason: `web search blocked by ${mode.label}` };
      if (action === "ask" && !(await this.promptAllow(ctx, "web_search", "*", "Allow web search?"))) {
        return { block: true, terminate: true, reason: "web search blocked" };
      }
      return undefined;
    }

    if (toolName !== "show_plan" && toolName !== "request_network_access" && !FILE_TOOL_SURFACE[toolName]) {
      const action = decide(mode, "tool", toolName);
      if (action === "deny") return { block: true, terminate: true, reason: `Tool "${toolName}" blocked by ${mode.label}` };
      if (
        action === "ask" &&
        !(await this.promptAllow(ctx, "tool", toolName, `Tool "${toolName}" — allow?`, learnForever?.("tool", toolName)))
      ) {
        return { block: true, terminate: true, reason: "tool blocked" };
      }
    }

    return undefined;
  }

  async onAgentSettled(ctx: ExtensionContext): Promise<void> {
    const current = this.workspace;
    if (!current) {
      this.workspaceFailure = undefined;
      return;
    }

    try {
      const review = await current.review();
      if (review.conflicts.length > 0) {
        ctx.ui.notify(`Result not applied due to conflicts (${review.conflicts.slice(0, 5).join(", ")}). Discarded.`, "warning");
        return;
      }
      if (review.changes.length === 0) return;
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("Result denied: Confirm and Debug require an interactive review. Staged changes were discarded.", "warning");
        return;
      }

      const approved = await showResultApproval(ctx, review.changes.length, review.diff);
      if (!approved) {
        ctx.ui.notify("Denied Result. Staged changes were discarded.", "info");
        return;
      }

      const result = await current.apply();
      if (result.conflicts.length > 0) {
        ctx.ui.notify(`Result not applied: conflicting workspace changes (${result.conflicts.join(", ")}).`, "warning");
        return;
      }
      ctx.ui.notify(`Approved Result. Applied ${result.applied.length} changed workspace path${result.applied.length === 1 ? "" : "s"}.`, "info");
    } catch (error) {
      const message = error instanceof WorkspaceConflictError
        ? `Result not applied due to workspace conflict: ${error.paths.join(", ")}.`
        : `Result not applied: ${error instanceof Error ? error.message : String(error)}. Staged changes were discarded.`;
      ctx.ui.notify(message, "error");
    } finally {
      await this.discardWorkspace(ctx).catch((err: unknown) => {
        ctx.ui.notify(`Could not remove temporary workspace: ${err instanceof Error ? err.message : String(err)}`, "warning");
      });
    }
  }

  async handleLiveNetworkAsk(
    host: string,
    port: number | undefined,
    ctx: ExtensionContext | undefined,
    onForever?: (domain: string) => Promise<void>,
  ): Promise<NetAskResult> {
    if (!ctx?.hasUI) return "dismiss";
    const target = port !== undefined ? `${host}:${port}` : host;
    const choice = await ctx.ui.select(`Network: bash wants to reach ${target} (not in the allowlist) — allow?`, [
      "Allow for session",
      "Allow forever",
      "Deny",
    ]);
    if (choice === "Allow for session") return "allow-session";
    if (choice === "Allow forever") {
      await onForever?.(host);
      return "allow-forever";
    }
    if (choice === "Deny") return "deny";
    return "dismiss";
  }

  async handleRequestNetworkAccess(
    params: { domains?: string[]; reason?: string },
    ctx: ExtensionContext,
    options: {
      mode: ModeDef;
      isNetworkFiltered: boolean;
      onForever?: (domains: string[]) => Promise<void>;
    },
  ) {
    const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
    const { domains = [], reason = "" } = params;
    const { mode, isNetworkFiltered, onForever } = options;

    if (!this.sandbox.ready || !isNetworkFiltered || this.net.open) {
      return text("Network is not filtered right now - no grant needed, just run the command.");
    }

    const normalized = [...new Set(domains.map(normalizeDomain).filter((d): d is string => d !== undefined))];
    const modeList = mode.sandbox.network?.allowedDomains ?? [];
    const need = normalized.filter((d) => !modeList.includes(d) && !this.net.isGranted(d));

    if (need.length === 0) return text("Already allowed — just run the command.");
    if (!ctx.hasUI) return text("Denied: no interactive user available to approve network access.");

    const choice = await ctx.ui.select(
      `Model requests network access to ${need.join(", ")} — ${reason.trim() || "no reason given"}. Allow?`,
      ["Allow for session", "Allow forever", "Deny"],
    );

    if (choice !== "Allow for session" && choice !== "Allow forever") {
      return text(`Denied by the user: ${need.join(", ")}. Don't retry these hosts.`);
    }

    this.net.grant(need);
    if (choice === "Allow forever" && onForever) {
      await onForever(need);
    }
    return text(`Granted: ${need.join(", ")}. Retry the blocked command now.`);
  }
}
