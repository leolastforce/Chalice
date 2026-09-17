/**
 * @georgedong32/permission-modes
 *
 * Claude-Code-style permission modes for the pi coding agent.
 *
 * Four modes (Tab): ask → plan → auto → bypass → ask
 *   - ask     Manual approval for edits, outside-cwd access, mutating bash.
 *   - plan    Read-only; only plan.md may be written.
 *   - auto    Tiered auto-approve + optional built-in classifier + risk blacklist.
 *   - bypass  Full auto-approve (old auto semantics); sparse security reminders.
 */

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs"
import { homedir } from "node:os";
import path from "node:path";
import {
  classifyToolCall,
  invalidateClassifierVerdictCache,
  readAgentsMdForClassifier,
  type ClassifierSessionContext,
} from "./classifier-client.ts";
import {
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
} from "./classifier-messages.ts";
import {
  loadPermissionModesConfig,
  resolveAutoModeConfig,
  resolveClassifierConfig,
} from "./config.ts";
import {
  restoreDangerousPermissionRules,
  stripDangerousPermissionRules,
} from "./dangerous-permissions.ts";
import {
  createDenialTrackingState,
  recordClassifierDenial,
  recordClassifierSuccess,
  shouldFallbackToPrompting,
  type DenialTrackingState,
} from "./denial-tracking.ts";
import {
  buildInjectionWarningBlock,
  scanBranchForInjectionSignals,
  TOOL_OUTPUT_INJECTION_WARNING,
} from "./injection-probe.ts";
import {
  readBranchEntries,
  readBranchMessages,
  readCustomEntryData,
  readGitBranch,
  readSessionId,
} from "./session-branch.ts";
import {
  accumulateBranchStats,
  emptyBranchStatsState,
} from "./branch-stats.ts";
import {
  addPermissionRule,
  loadMergedPermissionRules,
  warnIfLocalPermissionsNotGitignored,
} from "./permissions-loader.ts";
import {
  evaluateToolPermission,
  formatMergedRulesForDisplay,
  suggestAllowRuleForToolCall,
  type PermissionRule,
} from "./permissions.ts";
import {
  checkAutoRisk,
  commandReferencesSensitivePath,
  ensurePlanFile,
  extractPlanSection,
  extractTodoItems,
  filterSkillsFromPrompt,
  filterSubstantivePlanItems,
  findProjectRoot,
  formatCount,
  getPlanFilePath,
  hashPlan,
  injectModePrompt,
  isAutoFallbackBash,
  classifyBashTiers,
  isOutsideCwd,
  isPlanFilePath,
  isSafeCommand,
  isSensitivePath,
  listTrackedOutsideWrites,
  markCompletedSteps,
  popTrackedOutsideWrite,
  readPlanFile,
  resolveModePrompt,
  resolveWorkspacePath,
  restoreOutsideWrite,
  shouldSyncAssistantPlanToFile,
  trackOutsideWrite,
  writePlanFile,
  type OutsideWriteSnapshot,
  type PermissionMode,
  type PlanPhase,
  type TodoItem,
} from "./utils.ts";
import {
  runPlanApprovalDialog,
} from "./plan-approval-dialog.ts";
import {
  createForwardingPoller,
  defaultAgentDir,
  isSubagentChildProcess,
  pollForwardedResponse,
  resolveParentSessionId,
  writeForwardedRequest,
  writeForwardedResponse,
  type ForwardedDecision,
  type ForwardedPermissionRequest,
  type ForwardingPoller,
} from "./permission-forwarding.ts";
import {
  applyInheritedModeForChild,
  publishInheritedPermissionMode,
} from "./mode-inherit.ts";
import {
  ensureModelProfilesConfig,
  getActiveProfileName,
  listProfiles,
  loadModelProfiles,
  parseModelId,
  profileExists,
  resolveEffortForMode,
  resolveModelForMode,
  resolveSkillFilter,
  type ModelProfile,
  type ModelProfilesConfig,
} from "./profiles.ts";

type Mode = PermissionMode;

/** Effort / thinking levels accepted in model-profiles.json. */
const PROFILE_EFFORT_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const MODE_CYCLE: Mode[] = ["ask", "plan", "auto", "bypass"];

const MODE_META: Record<Mode, { icon: string; label: string; role: ThemeColor }> = {
  ask: { icon: "●", label: "Ask", role: "muted" },
  plan: { icon: "⏸", label: "Plan", role: "accent" },
  auto: { icon: "▶", label: "Auto", role: "warning" },
  bypass: { icon: "⚡", label: "Bypass", role: "error" },
};

// Tools available in plan mode (edit/write only for plan.md via tool_call gate).
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "edit", "write", "plan_ready"];
const PLAN_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const PLAN_DISABLED = new Set<string>();

type Block = { block: true; reason: string } | undefined;

/**
 * Cross-extension capability object (plan B7): the single typed channel to
 * pi-claude-code-tui — globalThis.__piPermissionModes. Duck-typed on both
 * sides; version gates consumers.
 */
export interface PmCapability {
	version: number;
	active: boolean;
	mode: string;
	workingStats: string | null;
}

export default function permissionModesExtension(pi: ExtensionAPI): void {
  // ---- state -------------------------------------------------------------
  let currentMode: Mode = "ask";
  let planExecuting = false;
  let planPhase: PlanPhase = "exploring";
  let lastExtractedPlanHash = "";
  let lastPlanOfferAt = 0;
  /** Suppress agent_end re-offer after the user dismisses plan approval (Stay/Esc/Refine). */
  let suppressPlanOfferUntil = 0;
  const PLAN_OFFER_COOLDOWN_MS = 60_000;
  let needsAskReminder = false;
  let needsBypassSecurityReminder = false;
  let pendingComplianceInject = false;
  let complianceCategory = "";
  let toolsBeforePlanMode: string[] | undefined;
  let planTodos: TodoItem[] = [];
  let projectRoot: string | null = null;
  let classifierConfig = resolveClassifierConfig(loadPermissionModesConfig());
  let autoModeConfig = resolveAutoModeConfig(loadPermissionModesConfig());
  let basePermissionRules: PermissionRule[] = [];
  let strippedDangerousRules: PermissionRule[] = [];
  let mergedPermissionRules: PermissionRule[] = [];
  let classifierDenialState: DenialTrackingState = createDenialTrackingState();
  const MAX_CLASSIFIER_FAILURES = 3;
  let forwardingPoller: ForwardingPoller | undefined;
  /** Survives poller restarts so the same inbox request is not double-prompted. */
  const forwardingClaimedIds = new Set<string>();

  function applyAutoModePermissionStrip(): void {
    if (currentMode === "auto") {
      const stripped = stripDangerousPermissionRules(basePermissionRules);
      strippedDangerousRules = stripped.stashed;
      mergedPermissionRules = stripped.active;
    } else {
      strippedDangerousRules = [];
      mergedPermissionRules = basePermissionRules;
    }
  }

  function reloadMergedPermissionRules(cwd: string): void {
    basePermissionRules = loadMergedPermissionRules(cwd);
    applyAutoModePermissionStrip();
    // Memoized verdicts may depend on the old rules — drop them (plan A5).
    invalidateClassifierVerdictCache();
  }

  // ---- model-profile state -----------------------------------------------
  // activeProfile === undefined means "no profile active" — the extension
  // works as before (no auto model switching). The /model-profile command and
  // --model-profile flag set this; persistState() persists it; session_start
  // restores it and re-applies the model.
  let activeProfile: string | undefined = undefined;
  let modelProfileConfig: ModelProfilesConfig = {};

  // streaming stats (for the working-indicator readout)
  let streamStart = 0;
  let outputAtStart = 0;
  let lastTps = 0;
  let gitBranch = "";

  // ---- small helpers -----------------------------------------------------
  const isAssistant = (m: any): boolean =>
    !!m && m.role === "assistant" && Array.isArray(m.content);

  const getText = (m: any): string =>
    Array.isArray(m?.content)
      ? m.content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n")
      : typeof m?.content === "string"
        ? m.content
        : "";

  function persistState(): void {
    pi.appendEntry("modes", {
      currentMode,
      activeProfile,
      planPhase,
      planExecuting,
      planTodos,
      lastExtractedPlanHash,
    });
  }

  type ApprovalDecision =
    | "allow"
    | "allow_always_local"
    | "allow_always_global"
    | "bypass"
    | "block";

  /**
   * Single place that executes an approval decision's side effects:
   * allow-always persistence + rule reload + gitignore warning + notify,
   * outside-write tracking on EVERY allow path, compliance-inject on block.
   * The three approval flows (interactive select, ask-mode inline select,
   * forwarded-parent responder) used to duplicate this and had diverged —
   * the ask flow dropped write tracking and notifications (plan B2).
   * Options narrow execution for the forwarding paths:
   * - ruleCwd: parent responder persists rules against the child's cwd
   * - persistRules:false when the other side already persisted (child poll)
   * - trackWrite:false on the parent responder (tracking is the child's job)
   * - complianceOnBlock:false in ask mode (no classifier compliance there)
   */
  async function applyApprovalDecision(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    decision: ApprovalDecision,
    opts: {
      category?: string;
      ruleCwd?: string;
      persistRules?: boolean;
      trackWrite?: boolean;
      complianceOnBlock?: boolean;
      blockReason?: string;
    } = {},
  ): Promise<Block | undefined> {
    const ruleCwd = opts.ruleCwd ?? ctx.cwd;
    const persistRules = opts.persistRules !== false;
    const trackWrite = opts.trackWrite !== false;

    const trackOutsideWrite = (): void => {
      if (trackWrite && (tool === "edit" || tool === "write")) {
        trackOutsideWriteIfNeeded(ctx, tool, String(input.path ?? ""));
      }
    };

    if (decision === "allow") {
      trackOutsideWrite();
      return undefined;
    }
    if (
      decision === "allow_always_local" ||
      decision === "allow_always_global"
    ) {
      if (persistRules) {
        const rule = suggestAllowRuleForToolCall(tool, input, ruleCwd);
        if (
          addPermissionRule({
            rule,
            behavior: "allow",
            destination:
              decision === "allow_always_local" ? "local" : "global",
            cwd: ruleCwd,
          })
        ) {
          reloadMergedPermissionRules(ctx.cwd);
          if (decision === "allow_always_local") {
            warnIfLocalPermissionsNotGitignored(ruleCwd, (msg) =>
              ctx.ui.notify(msg, "warning"),
            );
          }
          ctx.ui.notify(
            decision === "allow_always_local"
              ? `Added allow rule (project local): ${rule}`
              : `Added allow rule (global): ${rule}`,
          );
        }
      } else {
        // Rules were persisted by the other side; just pick them up.
        reloadMergedPermissionRules(ctx.cwd);
      }
      trackOutsideWrite();
      return undefined;
    }
    if (decision === "bypass") {
      await setMode("bypass", ctx);
      trackOutsideWrite();
      return undefined;
    }
    if (opts.complianceOnBlock !== false) {
      pendingComplianceInject = true;
      complianceCategory = opts.category ?? "user-prompt";
    }
    return {
      block: true,
      reason: opts.blockReason ?? `${tool} blocked by user`,
    };
  }

  async function promptWithPermissionOptions(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    label: string,
    category: string,
  ): Promise<Block> {
    if (!ctx.hasUI) {
      const isChild = isSubagentChildProcess();
      const parent = resolveParentSessionId();
      // Only forward to a parent session when we're clearly a subagent child.
      // PI_SUBAGENT_PARENT_SESSION alone is not sufficient — it's often set in
      // the parent process env and inherited by unrelated processes (tests,
      // ad-hoc node calls), which would block forever waiting for a response
      // that never comes. Fail closed otherwise.
      if (!parent || !isChild) {
        pendingComplianceInject = true;
        complianceCategory = category;
        return {
          block: true,
          reason: `${tool} needs approval: no UI available. ${label}`,
        };
      }
      const agentDir = defaultAgentDir();
      const requesterSessionId =
        readSessionId(ctx.sessionManager) ?? "";
      const { id, challenge } = await writeForwardedRequest({
        agentDir,
        targetSessionId: parent,
        requesterSessionId,
        tool,
        label,
        category,
        cwd: ctx.cwd,
        input,
      });
      const resp = await pollForwardedResponse(agentDir, parent, id, {
        challenge,
      });
      if (!resp?.approved) {
        pendingComplianceInject = true;
        complianceCategory = category;
        return {
          block: true,
          reason:
            resp?.denialReason ??
            `${tool} blocked: parent approval timed out or denied. ${label}`,
        };
      }
      if (
        resp.decision === "allow_always_local" ||
        resp.decision === "allow_always_global"
      ) {
        return applyApprovalDecision(ctx, tool, input, resp.decision, {
          persistRules: false,
        });
      }
      return applyApprovalDecision(ctx, tool, input, "allow");
    }
    const choice = await ctx.ui.select(`Allow ${tool}? ${label}`, [
      "Allow",
      "Allow always (this project)",
      "Allow always (global)",
      "Block",
    ]);
    const decision: ApprovalDecision =
      choice === "Allow always (this project)"
        ? "allow_always_local"
        : choice === "Allow always (global)"
          ? "allow_always_global"
          : choice === "Allow"
            ? "allow"
            : "block";
    return applyApprovalDecision(ctx, tool, input, decision, { category });
  }

  async function promptAutoTier3(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    reason: string,
    category: string,
  ): Promise<Block> {
    return promptWithPermissionOptions(ctx, tool, input, reason, category);
  }

  function classifierErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function logClassifierUnavailable(err: unknown, attempt: number): void {
    const debug = process.env.PERMISSION_MODES_CLASSIFIER_DEBUG === "1";
    const message = classifierErrorMessage(err);
    const line = `[permission-modes] Classifier unavailable (${attempt}/${MAX_CLASSIFIER_FAILURES}): ${message}`;
    if (debug) {
      console.warn(line);
      if (err instanceof Error && err.stack) console.debug(err.stack);
      return;
    }
    if (attempt >= MAX_CLASSIFIER_FAILURES) {
      console.warn(line);
    }
  }

  type LocalAutoTier3Decision =
    | { allow: true }
    | { allow: false; reason: string; category: string };

  function resolveLocalAutoTier3(
    tool: string,
    input: Record<string, unknown>,
    riskInput: {
      tool: string;
      command?: string;
      path?: string;
    },
    cwd: string,
  ): LocalAutoTier3Decision {
    const risk = checkAutoRisk(riskInput, cwd);
    if (risk.match) {
      return { allow: false, reason: risk.reason, category: risk.category };
    }

    const isKnownTier3 =
      tool === "bash" || tool === "edit" || tool === "write";
    if (!isKnownTier3) {
      return {
        allow: false,
        reason: `Tool "${tool}" is not auto-approved in auto mode. Enable classifier or switch to bypass.`,
        category: "unknown-tool",
      };
    }
    if (tool === "bash") {
      const cmd = String(input.command ?? "");
      if (cmd && !isAutoFallbackBash(cmd)) {
        return {
          allow: false,
          reason: `Mutating bash in auto mode: ${cmd}`,
          category: "mutating-bash",
        };
      }
    }
    return { allow: true };
  }

  function finishAutoTier3Allow(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
  ): undefined {
    if (tool === "edit" || tool === "write") {
      trackOutsideWriteIfNeeded(ctx, tool, String(input.path ?? ""));
    }
    return undefined;
  }

  function classifierDenyBlock(tool: string, reason: string): Block {
    return { block: true, reason: buildYoloRejectionMessage(reason) };
  }

  async function approveAutoTier3(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    riskInput: {
      tool: string;
      command?: string;
      path?: string;
    },
  ): Promise<Block> {
    const reviewHint = describeTier3Review(tool, input, ctx.cwd);

    if (classifierConfig.enabled) {
      for (let attempt = 1; attempt <= MAX_CLASSIFIER_FAILURES; attempt++) {
        try {
          const verdict = await classifyToolCall({
            modelRef: classifierConfig.model,
            session: collectClassifierSessionContext(ctx, reviewHint),
            pendingTool: { name: tool, input },
            registry: ctx.modelRegistry as any,
            autoMode: autoModeConfig,
            timeoutMs: classifierConfig.timeoutMs,
            jsonlTranscript: classifierConfig.jsonlTranscript,
            stage: classifierConfig.stage,
            includeAgentsMd: classifierConfig.includeAgentsMd,
            signal: ctx.signal,
            debug: process.env.PERMISSION_MODES_CLASSIFIER_DEBUG === "1",
          });
          if (!verdict.allow) {
            classifierDenialState = recordClassifierDenial(classifierDenialState);
            if (shouldFallbackToPrompting(classifierDenialState)) {
              return promptAutoTier3(
                ctx,
                tool,
                input,
                verdict.reason || "Blocked by auto classifier (denial limit)",
                "classifier-limit",
              );
            }
            return classifierDenyBlock(
              tool,
              verdict.reason || "Blocked by auto classifier",
            );
          }
          classifierDenialState = recordClassifierSuccess(classifierDenialState);
          return finishAutoTier3Allow(ctx, tool, input);
        } catch (err) {
          if (attempt < MAX_CLASSIFIER_FAILURES) {
            if (process.env.PERMISSION_MODES_CLASSIFIER_DEBUG === "1") {
              console.debug(
                `[permission-modes] Classifier retry (${attempt}/${MAX_CLASSIFIER_FAILURES}): ${classifierErrorMessage(err)}`,
              );
            }
            continue;
          }
          logClassifierUnavailable(err, attempt);
          if (classifierConfig.failClosed !== false) {
            return classifierDenyBlock(
              tool,
              buildClassifierUnavailableMessage(tool, classifierConfig.model),
            );
          }
          break;
        }
      }
    }

    const local = resolveLocalAutoTier3(tool, input, riskInput, ctx.cwd);
    if (!local.allow) {
      return promptAutoTier3(ctx, tool, input, local.reason, local.category);
    }
    classifierDenialState = recordClassifierSuccess(classifierDenialState);
    return finishAutoTier3Allow(ctx, tool, input);
  }

  function trackOutsideWriteIfNeeded(
    ctx: ExtensionContext,
    tool: "edit" | "write",
    pathStr: string,
  ): void {
    if (!pathStr || !isOutsideCwd(pathStr, ctx.cwd)) return;
    const resolvedPath = resolveWorkspacePath(pathStr, ctx.cwd);
    let backupContent: string | null = null;
    try {
      backupContent = readFileSync(resolvedPath, "utf-8");
    } catch {
      backupContent = null;
    }
    trackOutsideWrite(ctx.cwd, {
      timestamp: new Date().toISOString(),
      originalPath: resolvedPath,
      toolName: tool,
      backupContent,
    });
    if (ctx.hasUI) {
      ctx.ui.notify(
        `📝 tracked outside-cwd ${tool}: ${shortenPath(resolvedPath)}`,
        "info",
      );
    }
  }

  function describeTier3Review(
    tool: string,
    input: Record<string, unknown>,
    cwd: string,
  ): string {
    if (tool === "bash") {
      const cmd = String(input.command ?? "");
      if (cmd && !isSafeCommand(cmd)) {
        return "Bash did not pass read-only allowlist; may include writes, installs, or unknown binaries.";
      }
      return "Bash requires tier-3 review.";
    }
    if (tool === "edit" || tool === "write") {
      const pathStr = String(input.path ?? "");
      if (pathStr && isOutsideCwd(pathStr, cwd)) {
        return `Write/edit outside working directory (${cwd}).`;
      }
      return "File write/edit requires tier-3 review.";
    }
    return `Tool "${tool}" is not auto-approved without classifier.`;
  }

  function collectClassifierSessionContext(
    ctx: ExtensionContext,
    reviewHint?: string,
  ): ClassifierSessionContext {
    let branch: ClassifierSessionContext["branch"] = [];
    try {
      branch = readBranchEntries(ctx.sessionManager);
    } catch {
      // classifier still runs with pending action only
    }
    const includeAgentsMd = classifierConfig.includeAgentsMd !== false;
    return {
      cwd: ctx.cwd,
      mode: currentMode,
      branch,
      reviewHint,
      agentsMd: includeAgentsMd
        ? readAgentsMdForClassifier(ctx.cwd)
        : null,
    };
  }

  // ---- tool gating -------------------------------------------------------
  function applyToolRestrictions(): void {
    if (planExecuting) {
      if (toolsBeforePlanMode !== undefined) {
        pi.setActiveTools(toolsBeforePlanMode);
        toolsBeforePlanMode = undefined;
      }
      return;
    }
    if (currentMode === "plan") {
      if (toolsBeforePlanMode === undefined)
        toolsBeforePlanMode = pi.getActiveTools();
      const kept = toolsBeforePlanMode.filter((t) => !PLAN_DISABLED.has(t));
      pi.setActiveTools([...new Set([...kept, ...PLAN_TOOLS])]);
    } else if (toolsBeforePlanMode !== undefined) {
      pi.setActiveTools(toolsBeforePlanMode);
      toolsBeforePlanMode = undefined;
    }
  }

  // ---- mode switching ----------------------------------------------------
  async function setMode(mode: Mode, ctx: ExtensionContext): Promise<void> {
    const prev = currentMode;

    if (prev === "auto" && mode !== "auto" && strippedDangerousRules.length) {
      basePermissionRules = restoreDangerousPermissionRules(
        mergedPermissionRules,
        strippedDangerousRules,
      );
      strippedDangerousRules = [];
    }

    currentMode = mode;
    needsAskReminder = mode === "ask";
    needsBypassSecurityReminder = mode === "bypass";
    pendingComplianceInject = false;
    complianceCategory = "";
    planExecuting = false;

    if (mode === "auto") {
      classifierDenialState = createDenialTrackingState();
      applyAutoModePermissionStrip();
    } else if (prev === "auto") {
      applyAutoModePermissionStrip();
    }

    if (mode !== "plan") {
      planPhase = "exploring";
      lastExtractedPlanHash = "";
    }
    if (mode === "plan") {
      ensurePlanFile(ctx.cwd);
      if (prev !== "plan") planPhase = "exploring";
    }

    planTodos = [];
    if (ctx.hasUI) ctx.ui.setWidget("plan-todos", undefined);

    applyToolRestrictions();
    updateStatus(ctx);
    await applyProfileModelForMode(mode, ctx);
    persistState();
    publishInheritedPermissionMode(mode);
    publishCapability({ mode });
  }

  function cycleMode(ctx: ExtensionContext): void {
    const idx = MODE_CYCLE.indexOf(currentMode);
    void setMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length], ctx);
    if (ctx.hasUI) ctx.ui.notify(`Mode: ${MODE_META[currentMode].label}`);
  }

  // ---- model profile logic ----------------------------------------------
  /**
   * Switch the active model to match the one defined in `activeProfile` for
   * the given mode. No-op when no profile is active or when the profile has
   * no mapping for the mode. All failures log a notification and keep the
   * current model — never throw, never block the user.
   */
  async function applyProfileModelForMode(
    mode: Mode,
    ctx: ExtensionContext,
  ): Promise<void> {
    // Lazy first-time activation: if nothing has been activated but a
    // config file exists on disk, try to pick up the user's `active` profile
    // (or the `default` profile) so mode switches "just work".
    if (activeProfile === undefined) {
      const cfg = loadModelProfiles();
      if (Object.keys(cfg).length === 0) return;
      const candidate = cfg.active || "default";
      if (!profileExists(cfg, candidate)) return;
      activeProfile = candidate;
      modelProfileConfig = cfg;
    }

    // Re-load lazily to pick up external edits between mode switches.
    // Then re-stamp `active` with the in-memory `activeProfile` so the
    // shared `resolveModelForMode()` helper (which reads `config.active`)
    // honors any in-memory profile switches done via `/model-profile` or
    // Alt+I — the on-disk file is NOT modified here.
    const reloaded = loadModelProfiles();
    modelProfileConfig =
      activeProfile !== undefined && reloaded.active !== activeProfile
        ? { ...reloaded, active: activeProfile }
        : reloaded;

    const modelId = resolveModelForMode(modelProfileConfig, mode);
    if (!modelId) return; // profile has no mapping for this mode — keep current model

    const parsed = parseModelId(modelId);
    if (!parsed) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `Invalid model ID "${modelId}" in profile "${activeProfile}"`,
          "warning",
        );
      return;
    }

    const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
    if (!model) {
      if (ctx.hasUI)
        ctx.ui.notify(`Model "${modelId}" not found in registry`, "warning");
      return;
    }

    const success = await pi.setModel(model);
    if (!success) {
      if (ctx.hasUI)
        ctx.ui.notify(`No API key available for "${modelId}"`, "warning");
      return;
    }

    const effort = resolveEffortForMode(modelProfileConfig, mode);
    if (!effort) return;
    if (!PROFILE_EFFORT_LEVELS.has(effort)) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `Unknown effort "${effort}" in profile "${activeProfile}" (expected: ${[...PROFILE_EFFORT_LEVELS].join(", ")})`,
          "warning",
        );
      return;
    }
    if (typeof pi.setThinkingLevel === "function") {
      pi.setThinkingLevel(effort as any);
    }
  }

  async function setActiveProfile(
    name: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const config = loadModelProfiles();
    if (!profileExists(config, name)) {
      if (ctx.hasUI) ctx.ui.notify(`Unknown profile "${name}"`, "error");
      return;
    }
    activeProfile = name;
    modelProfileConfig = config;
    await applyProfileModelForMode(currentMode, ctx);
    updateStatus(ctx);
    persistState();
    if (ctx.hasUI) ctx.ui.notify(`Profile "${name}" activated`, "info");
  }

  // ---- UI: status, footer, plan widget, working stats --------------------
  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("modes", undefined);
  }

  function shortenPath(p: string): string {
    const home = homedir();
    return p && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  }

  function installFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setFooter((_tui, theme) => ({
      render(width: number): string[] {
        if (width <= 0) return [];

        const mode = MODE_META[currentMode];
        const cwd = shortenPath(ctx.cwd);
        const branch = readGitBranch(ctx.sessionManager) ?? gitBranch;
        const location = branch ? `${cwd} · ${branch}` : cwd;
        const contextUsage = ctx.getContextUsage();
        const contextText = contextUsage?.percent == null
          ? "context ?"
          : `context ${contextUsage.percent.toFixed(0)}%`;
        const model = ctx.model?.name || ctx.model?.id || "no model";
        const thinking = ctx.thinkingLevel ? `think:${ctx.thinkingLevel}` : "think:off";
        const profile = activeProfile ? `profile:${activeProfile}` : "profile:default";

        const locationText = theme.fg("muted", truncateToWidth(location, Math.max(1, width - 1), "…"));
        const contextTextStyled = theme.fg(
          contextUsage?.percent != null && contextUsage.percent > 90
            ? "error"
            : contextUsage?.percent != null && contextUsage.percent > 70
              ? "warning"
              : "dim",
          contextText,
        );
        const modelText = theme.fg("text", truncateToWidth(`${model} · ${thinking}`, Math.max(1, width - 1), "…"));

        const firstLinePlain = `${location}  ${contextText}  ${model} · ${thinking}`;
        const firstLine = width >= 72 && visibleWidth(firstLinePlain) <= width
          ? locationText + " ".repeat(Math.max(2, Math.floor((width - visibleWidth(location) - visibleWidth(contextText) - visibleWidth(modelText)) / 2)))
            + contextTextStyled
            + " ".repeat(Math.max(2, width - visibleWidth(location) - visibleWidth(contextText) - visibleWidth(modelText) - 4))
            + modelText
          : truncateToWidth(`${location}  ${contextText}  ${model} · ${thinking}`, width, "…");

        const modeText = `${mode.icon} ${mode.label}`;
        const shortcuts = "Tab mode · Shift+Tab thinking · Alt+I profile";
        const secondLinePlain = `${modeText}  ·  ${profile}  ·  ${shortcuts}`;
        const secondLine = width >= 60 && visibleWidth(secondLinePlain) <= width
          ? theme.fg(mode.role, modeText) + theme.fg("dim", `  ·  ${profile}  ·  ${shortcuts}`)
          : theme.fg(mode.role, truncateToWidth(`${modeText} · Tab mode`, width, "…"));

        return [firstLine, secondLine];
      },
      invalidate() {},
    }));
  }

  function updatePlanWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!planTodos.length) {
      ctx.ui.setWidget("plan-todos", undefined);
      return;
    }
    const lines = planTodos.map((t) =>
      t.completed
        ? ctx.ui.theme.fg("success", "☑ ") +
          ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text))
        : `${ctx.ui.theme.fg("muted", "☐ ")}${t.text}`,
    );
    ctx.ui.setWidget("plan-todos", lines);
  }

  // Streaming chunks arrive while the branch is frozen (pi appends entries
  // on message_end), so per-chunk work is O(new entries), not O(session
  // length); a moved prefix (navigate/fork/switch) forces a full recompute
  // (plan A1, property-tested in branch-stats.test.ts).
  const branchStatsState = emptyBranchStatsState();

  function computeStats(ctx: ExtensionContext): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  } {
    try {
      return accumulateBranchStats(
        readBranchEntries(ctx.sessionManager),
        branchStatsState,
      );
    } catch {
      // Render path: keep last totals rather than throw.
      return { ...branchStatsState.accum };
    }
  }

  function workingStatsParts(ctx: ExtensionContext): string[] {
    const s = computeStats(ctx);
    const parts = [`↑${formatCount(s.input)}`, `↓${formatCount(s.output)}`];
    if (s.cacheRead) parts.push(`R${formatCount(s.cacheRead)}`);
    if (lastTps > 0) parts.push(`⚡${Math.round(lastTps)} tok/s`);
    parts.push(`$${s.cost.toFixed(3)}`);
    const usage = (ctx as any).getContextUsage?.();
    if (usage && usage.percent != null) {
      parts.push(`${Math.round(usage.percent)}% ctx`);
    }
    return parts;
  }

  function renderWorkingMessage(ctx: ExtensionContext): string {
    return `Working… (${workingStatsParts(ctx).join(" · ")})`;
  }

  // ---- Capability channel to pi-claude-code-tui (plan B7) ------------------
  // One typed, versioned namespace replaces the untyped globals; the legacy
  // __pmWorkingStats key stays published for one compatibility cycle (older
  // cctui builds read it). Consumers detect via `version >= 1`.
  function publishCapability(patch: Partial<PmCapability>): void {
    const g = globalThis as Record<string, unknown>;
    const current = (g.__piPermissionModes as PmCapability | undefined) ?? {
      version: 1,
      active: true,
      mode: currentMode,
      workingStats: null,
    };
    g.__piPermissionModes = { ...current, ...patch, version: 1, active: true };
  }

  function refreshWorkingMessage(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    // Integration: when the CC-TUI extension is active, its status row owns
    // the working line — publish the stats there instead of occupying pi's
    // working-message slot (which would render a duplicate second line).
    const g = globalThis as Record<string, unknown>;
    const ccTuiActive = (g.__piCcTui as { active?: boolean } | undefined)?.active === true || g.__ccTuiActive === true;
    if (ccTuiActive) {
      const stats = workingStatsParts(ctx).join(" · ");
      publishCapability({ workingStats: stats });
      // Legacy key (one compatibility cycle for older cctui builds).
      g.__pmWorkingStats = `(${stats})`;
      return;
    }
    ctx.ui.setWorkingMessage(
      ctx.ui.theme.fg("dim", renderWorkingMessage(ctx)),
    );
  }

  async function applyConfiguredPermissionRules(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<Block | "allow" | "passthrough"> {
    const verdict = evaluateToolPermission(
      tool,
      input,
      ctx.cwd,
      mergedPermissionRules,
    );
    if (verdict.behavior === "deny") {
      return {
        block: true,
        reason: `Denied by permission rule [${verdict.source}]: ${verdict.rule}`,
      };
    }
    if (verdict.behavior === "allow") {
      if (tool === "edit" || tool === "write") {
        trackOutsideWriteIfNeeded(ctx, tool, String(input.path ?? ""));
      }
      return "allow";
    }
    if (verdict.behavior === "ask") {
      return promptAutoTier3(
        ctx,
        tool,
        input,
        `permission rule requires approval: ${verdict.rule}`,
        "permission-ask",
      );
    }
    return "passthrough";
  }

  // ---- prompts -----------------------------------------------------------
  async function promptApproval(
    ctx: ExtensionContext,
    tool: string,
    label: string,
    input: Record<string, unknown> = {},
  ): Promise<Block> {
    return promptWithPermissionOptions(ctx, tool, input, label, "user-prompt");
  }

  // ---- commands / shortcut / flag ---------------------------------------
  for (const mode of ["ask", "plan", "auto", "bypass"] as Mode[]) {
    pi.registerCommand(mode, {
      description: `Switch to ${MODE_META[mode].label} mode`,
      handler: async (_args, ctx) => setMode(mode, ctx),
    });
  }

  pi.registerCommand("permissions", {
    description:
      "List merged permission rules (allow/deny/ask) from global + project config",
    handler: async (_args, ctx) => {
      reloadMergedPermissionRules(ctx.cwd);
      const text = formatMergedRulesForDisplay(mergedPermissionRules);
      if (ctx.hasUI) {
        pi.sendMessage(
          {
            customType: "permissions-list",
            content: `**Permission rules**\n\n\`\`\`\n${text}\n\`\`\``,
            display: true,
          },
          { triggerTurn: false },
        );
      } else {
        console.log(text);
      }
    },
  });

  pi.registerCommand("mode", {
    description:
      "Show or set the permission mode (ask | plan | auto | bypass)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg && (MODE_CYCLE as string[]).includes(arg)) {
        await setMode(arg as Mode, ctx);
        return;
      }
      // Accept "default" as an alias for "ask" during migration period.
      if (arg === "default") {
        await setMode("ask", ctx);
        return;
      }
      if (!ctx.hasUI) return;
      const choice = await ctx.ui.select(
        "Select mode:",
        MODE_CYCLE.map((m) => MODE_META[m].label),
      );
      const picked = MODE_CYCLE.find((m) => MODE_META[m].label === choice);
      if (picked) await setMode(picked, ctx);
    },
  });

  pi.registerCommand("plan-execute", {
    description:
      "Execute the current plan immediately (switches to auto mode with step tracking)",
    handler: async (_args, ctx) => {
      if (currentMode !== "plan" && !planExecuting) {
        ctx.ui.notify("Not in plan mode. Use /plan first.", "warning");
        return;
      }
      const planContent = readPlanFile(ctx.cwd);
      const extracted = filterSubstantivePlanItems(
        planContent ? extractTodoItems(planContent) : [],
      );
      if (!extracted.length) {
        ctx.ui.notify("No plan steps found in plan.md. Write a plan first.", "warning");
        return;
      }
      planExecuting = true;
      planPhase = "executing";
      planTodos = extracted;
      currentMode = "auto";
      applyToolRestrictions();
      updateStatus(ctx);
      updatePlanWidget(ctx);
      persistState();
      await applyProfileModelForMode("auto", ctx);
      const steps = planTodos.map((t) => `${t.step}. ${t.text}`).join("\n");
      pi.sendMessage(
        {
          customType: "modes-execute",
          content: `Execute the plan now. Steps:\n${steps}\n\nStart with step 1. After finishing each step, include a [DONE:n] tag in your reply.`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });

  // ---- plan approval helpers ---------------------------------------------
  function markPlanOfferHandled(planContent: string): void {
    lastPlanOfferAt = Date.now();
    // Keep agent_end from immediately re-opening the same plan dialog after Stay/Esc.
    suppressPlanOfferUntil = Date.now() + PLAN_OFFER_COOLDOWN_MS;
    if (planContent) {
      lastExtractedPlanHash = hashPlan(planContent);
    }
  }

  async function promptPlanRefinement(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    planPhase = "refining";
    const refinement = await ctx.ui.editor("Refine the plan:", "");
    if (refinement?.trim()) {
      pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
    }
  }

  function planReviewClosedToolResult() {
    return {
      content: [
        {
          type: "text" as const,
          text: "Plan review closed. Wait for the user's next message; do not continue on your own.",
        },
      ],
      terminate: true as const,
    };
  }

  // ---- plan_ready tool (model-initiated plan submission) -------------------
  const PLAN_READY_TOOL_NAME = "plan_ready";

  pi.registerTool(defineTool({
    name: PLAN_READY_TOOL_NAME,
    label: "Plan Ready",
    description:
      "Submit the completed plan to the user for approval. Only available in plan mode. The user will see the plan and choose to execute, refine, or stay in plan mode.",
    promptSnippet:
      "Call plan_ready when your plan in plan.md is complete and ready for user review.",
    promptGuidelines: [
      "Only call plan_ready when you have finished exploring and the plan file contains a concrete, numbered implementation plan.",
      "Do NOT call plan_ready if the plan still has open questions or incomplete sections.",
      "After calling plan_ready, stop and wait for the user's decision. Do not begin implementation.",
      "If the user asks to refine, update plan.md and call plan_ready again when ready.",
    ],
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({ description: "Brief one-line summary of the plan for the approval dialog." }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (currentMode !== "plan") {
        return {
          content: [{ type: "text", text: "plan_ready is only available in plan mode. Current mode: " + currentMode }],
        };
      }
      const planContent = readPlanFile(ctx.cwd);
      const extracted = filterSubstantivePlanItems(
        planContent ? extractTodoItems(planContent) : [],
      );
      if (!extracted.length) {
        return {
          content: [{ type: "text", text: "No plan steps found in plan.md. Write a numbered plan first, then call plan_ready." }],
        };
      }

      planTodos = extracted;
      persistState();
      updatePlanWidget(ctx);

      const summary = params.summary?.trim() || undefined;
      const stepsPreview = extracted.map((t) => `${t.step}. ${t.text}`).join("\n");

      if (!ctx.hasUI) {
        // Headless: auto-execute
        const summaryLine = summary ? `${summary}\n\n` : "";
        return {
          content: [{ type: "text", text: `Plan submitted (headless auto-execute).\n${summaryLine}${stepsPreview}` }],
        };
      }

      // Suppress agent_end re-offer while this dialog is open and after dismiss.
      markPlanOfferHandled(planContent ?? "");
      const choice = await runPlanApprovalDialog(ctx, {
        summary,
        planContent: planContent ?? "",
        stepCount: extracted.length,
      });
      markPlanOfferHandled(planContent ?? "");

      if (choice === "execute") {
        planExecuting = true;
        planPhase = "executing";
        currentMode = "auto";
        applyToolRestrictions();
        updateStatus(ctx);
        persistState();
        await applyProfileModelForMode("auto", ctx);
        const steps = planTodos.map((t) => `${t.step}. ${t.text}`).join("\n");
        pi.sendMessage(
          {
            customType: "modes-execute",
            content: `Execute the plan now. Steps:\n${steps}\n\nStart with step 1. After finishing each step, include a [DONE:n] tag in your reply.`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        return {
          content: [{ type: "text", text: "Plan approved by user. Switching to execution mode." }],
          terminate: true,
        };
      }

      if (choice === "refine") {
        await promptPlanRefinement(ctx);
        return planReviewClosedToolResult();
      }

      // stay | cancel (Esc): one dismiss returns to the input prompt.
      return planReviewClosedToolResult();
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", "plan_ready ") + theme.fg("muted", truncateToWidth(String(args?.summary ?? ""), 60)),
        0, 0,
      );
    },
    renderResult(result, _options, theme) {
      const first = result.content?.find((c: any) => c.type === "text");
      return new Text(theme.fg("muted", truncateToWidth(String(first?.text ?? ""), 80)), 0, 0);
    },
  }));

  // ---- /model-profile command -------------------------------------------
  // Show, list, or activate a model profile from `~/.pi/agent/model-profiles.json`.
  pi.registerCommand("model-profile", {
    description:
      "Show or set model profile (named set of per-mode models from ~/.pi/agent/model-profiles.json)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();

      if (!arg) {
        // No args → show interactive selector
        const config = loadModelProfiles();
        const names = listProfiles(config);
        if (!names.length) {
          if (ctx.hasUI)
            ctx.ui.notify(
              "No profiles found in ~/.pi/agent/model-profiles.json",
              "warning",
            );
          return;
        }
        if (!ctx.hasUI) return;
        const choice = await ctx.ui.select("Select model profile:", names);
        if (!choice) return;
        await setActiveProfile(choice, ctx);
        return;
      }

      if (arg === "list") {
        const config = loadModelProfiles();
        const names = listProfiles(config);
        if (!names.length) {
          if (ctx.hasUI)
            ctx.ui.notify(
              "No profiles found in ~/.pi/agent/model-profiles.json",
              "info",
            );
          return;
        }
        const activeName = getActiveProfileName(config);
        const lines = names.map((n) => {
          const p = config[n] as ModelProfile;
          const mappings = ["ask", "plan", "auto", "bypass"]
            .map((m) => `${m}:${(p as any)[m] || "-"}`)
            .join(" ");
          const active = n === activeName ? " (active)" : "";
          return `${n}${active}: ${mappings}`;
        });
        pi.sendMessage(
          {
            customType: "model-profile-list",
            content: `Model profiles:\n${lines.join("\n")}`,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      await setActiveProfile(arg, ctx);
    },
  });

  // ---- /outside-writes + /undo-outside-writes (NEW v1.1.3) --------------
  // Format a snapshot for display in lists/selectors.
  function formatSnapshotForDisplay(
    snap: OutsideWriteSnapshot,
    externallyModified = false,
  ): string {
    const ts = snap.timestamp.replace("T", " ").slice(0, 19);
    const action = snap.backupContent === null ? "would delete" : "would restore";
    const flag = externallyModified ? " \u26a0 externally modified" : "";
    return `${ts} \u00b7 ${snap.toolName} \u00b7 ${snap.originalPath} (${action})${flag}`;
  }

  // Detect if a file has been externally modified since its snapshot was taken.
  // Heuristic: if multiple snapshots exist for the same path, OR the current
  // file content differs from the snapshot's backupContent, the file is
  // considered externally modified.
  function isExternallyModified(
    snap: OutsideWriteSnapshot,
    allSnaps: OutsideWriteSnapshot[],
  ): boolean {
    const samePath = allSnaps.filter((s) => s.originalPath === snap.originalPath);
    if (samePath.length > 1) return true;
    try {
      const current = readFileSync(snap.originalPath, "utf-8");
      return current !== snap.backupContent;
    } catch {
      return false;
    }
  }

  pi.registerCommand("outside-writes", {
    description:
      "List tracked outside-cwd writes from auto mode (read-only; does not undo)",
    handler: async (_args, ctx) => {
      const snaps = listTrackedOutsideWrites(ctx.cwd);
      if (!snaps.length) {
        if (ctx.hasUI) ctx.ui.notify("No tracked outside-cwd writes", "info");
        return;
      }
      const lines = snaps.map((s) => formatSnapshotForDisplay(s, isExternallyModified(s, snaps)));
      pi.sendMessage(
        {
          customType: "outside-writes-list",
          content: `Tracked outside-cwd writes (${snaps.length}):\n${lines.join("\n")}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("undo-outside-writes", {
    description:
      "Restore files modified by auto mode outside cwd. No args = selector; 'all' = restore all; '--list' = list only",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();

      // --list: alias for /outside-writes
      if (arg === "--list" || arg === "list") {
        const snaps = listTrackedOutsideWrites(ctx.cwd);
        if (!snaps.length) {
          if (ctx.hasUI) ctx.ui.notify("No tracked outside-cwd writes", "info");
          return;
        }
        const lines = snaps.map((s) => formatSnapshotForDisplay(s, isExternallyModified(s, snaps)));
        pi.sendMessage(
          {
            customType: "outside-writes-list",
            content: `Tracked outside-cwd writes (${snaps.length}):\n${lines.join("\n")}`,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      const allSnaps = listTrackedOutsideWrites(ctx.cwd);
      if (!allSnaps.length) {
        if (ctx.hasUI)
          ctx.ui.notify("No tracked outside-cwd writes to undo", "info");
        return;
      }

      if (arg === "all") {
        // Restore all without prompting
        let restored = 0;
        let deleted = 0;
        let warned = 0;
        const externallyModifiedPaths = new Set(
          allSnaps
            .filter((s) => isExternallyModified(s, allSnaps))
            .map((s) => s.originalPath),
        );
        for (const snap of allSnaps) {
          const result = restoreOutsideWrite(snap);
          if (result.action === "restored") restored++;
          else if (result.action === "deleted") deleted++;
          if (externallyModifiedPaths.has(snap.originalPath)) warned++;
          popTrackedOutsideWrite(ctx.cwd, snap);
        }
        if (ctx.hasUI) {
          const warnMsg =
            warned > 0
              ? ` (${warned} file(s) externally modified \u2014 restored anyway)`
              : "";
          ctx.ui.notify(
            `Restored ${restored}, deleted ${deleted} tracked write(s)${warnMsg}`,
            "info",
          );
        }
        return;
      }

      // No args: interactive selector (newest first)
      if (!ctx.hasUI) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "No UI available; pass 'all' or '--list' as argument",
            "warning",
          );
        return;
      }
      const ordered = [...allSnaps].reverse();
      const choice = await ctx.ui.select(
        "Restore which tracked outside-cwd write? (newest first)",
        ordered.map((s) =>
          formatSnapshotForDisplay(s, isExternallyModified(s, allSnaps)),
        ),
      );
      if (!choice) return;
      const picked = ordered.find(
        (s) =>
          formatSnapshotForDisplay(s, isExternallyModified(s, allSnaps)) === choice,
      );
      if (!picked) return;
      const wasExternal = isExternallyModified(picked, allSnaps);
      const result = restoreOutsideWrite(picked);
      popTrackedOutsideWrite(ctx.cwd, picked);
      const action = result.action === "deleted" ? "Deleted" : "Restored";
      const warnSuffix = wasExternal
        ? " (\u26a0 file was externally modified \u2014 restored from snapshot anyway)"
        : "";
      ctx.ui.notify(`${action} ${picked.originalPath}${warnSuffix}`, "info");
    },
  });


  pi.registerShortcut("tab", {
    description: "Cycle mode: Ask → Plan → Auto → Bypass",
    handler: async (ctx) => cycleMode(ctx),
  });

  // Alt+T: cycle the thinking level. pi has no built-in cycle helper, and setThinkingLevel
  // clamps to the model's capabilities, so we advance to the next level the model actually
  // accepts (skipping ones it clamps away). The footer reflects the new level live.
  const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ] as const;
  function cycleThinkingLevel(ctx: ExtensionContext): void {
    const get = (): string =>
      typeof (pi as any).getThinkingLevel === "function"
        ? (pi as any).getThinkingLevel()
        : "off";
    const setLevel = (pi as any).setThinkingLevel as
      | ((l: string) => void)
      | undefined;
    if (typeof setLevel !== "function") return;
    const cur = get();
    let i = THINKING_LEVELS.indexOf(cur as (typeof THINKING_LEVELS)[number]);
    if (i < 0) i = 0;
    for (let step = 1; step <= THINKING_LEVELS.length; step++) {
      const next = THINKING_LEVELS[(i + step) % THINKING_LEVELS.length];
      setLevel(next);
      const applied = get();
      if (applied !== cur) {
        if (ctx.hasUI) ctx.ui.notify(`Thinking: ${applied}`, "info");
        return;
      }
    }
    if (ctx.hasUI)
      ctx.ui.notify(
        `Thinking: ${get()} (model supports no other levels)`,
        "info",
      );
  }

  pi.registerShortcut("alt+t", {
    description:
      "Cycle thinking level (off → minimal → low → medium → high → xhigh)",
    handler: async (ctx) => cycleThinkingLevel(ctx),
  });

  // Alt+I: cycle through model profiles defined in `~/.pi/agent/model-profiles.json`.
  // Mirrors Shift+Tab's cycle-by-one behavior: starts at the profile after the
  // currently active one and wraps. Falls back to the first profile when no
  // profile is active yet. Always re-applies the model for the current mode,
  // so the UI (footer) updates immediately.
  async function cycleProfile(ctx: ExtensionContext): Promise<void> {
    const config = loadModelProfiles();
    const names = listProfiles(config);
    if (!names.length) {
      if (ctx.hasUI)
        ctx.ui.notify(
          "No profiles found in ~/.pi/agent/model-profiles.json",
          "warning",
        );
      return;
    }
    // Determine the index of the next profile. If no profile is active yet,
    // we treat the current `config.active` (or "default") as the implicit one
    // so cycling always advances.
    const currentName =
      activeProfile ?? getActiveProfileName(config) ?? names[0]!;
    let i = names.indexOf(currentName);
    if (i < 0) i = -1; // unknown current → start before the first
    const next = names[(i + 1) % names.length]!;
    await setActiveProfile(next, ctx);
  }

  pi.registerShortcut("alt+i", {
    description:
      "Cycle model profile (next profile from ~/.pi/agent/model-profiles.json)",
    handler: async (ctx) => cycleProfile(ctx),
  });

  // NB: pi has a built-in `--mode` (output mode: text/json/rpc), so the start-mode
  // flag must use a distinct name to avoid being shadowed at parse time.
  pi.registerFlag("permission-mode", {
    description:
      "Start in a permission mode: ask, plan, auto, or bypass (accepts 'default' as alias for 'ask')",
    type: "string",
    default: "ask",
  });

  pi.registerFlag("model-profile", {
    description:
      "Start with a named model profile from ~/.pi/agent/model-profiles.json",
    type: "string",
  });

  /** Simple glob-style pattern matching for autoMode.allow / soft_deny rules. */
  function matchAutoModePattern(command: string, pattern: string): boolean {
    const trimmed = command.trim();
    const p = pattern.trim();
    if (trimmed === p) return true;
    if (p.endsWith("*")) {
      const prefix = p.slice(0, -1).trim();
      return trimmed.startsWith(prefix);
    }
    return trimmed.includes(p);
  }

  function allowToolCall(): undefined {
    if (currentMode === "auto") {
      classifierDenialState = recordClassifierSuccess(classifierDenialState);
    }
    return undefined;
  }

  // ---- tool_call gate ----------------------------------------------------
  pi.on("tool_call", async (event, ctx): Promise<Block> => {
    const tool = event.toolName;
    const input = (event.input ?? {}) as Record<string, unknown>;

    // BYPASS: approve everything; still track outside-cwd writes for undo.
    // Kept ahead of the plan-file probe: bypass never reads the plan file
    // and the probe does per-call FS I/O (plan A2).
    if (currentMode === "bypass") {
      if (tool === "edit" || tool === "write") {
        trackOutsideWriteIfNeeded(ctx, tool, String(input.path ?? ""));
      }
      return undefined;
    }

    const planFilePath = getPlanFilePath(ctx.cwd);

    const permResult = await applyConfiguredPermissionRules(ctx, tool, input);
    if (permResult === "allow") return allowToolCall();
    if (permResult !== "passthrough") {
      // Plan exploration: allow read-only tools even when permission rules
      // would ask, but still honor explicit deny rules.
      if (
        currentMode === "plan" &&
        PLAN_READ_TOOLS.has(tool) &&
        !String((permResult as { reason?: string }).reason ?? "").startsWith(
          "Denied by permission rule",
        )
      ) {
        return undefined;
      }
      return permResult;
    }

    // PLAN EXECUTION: use auto-mode tiered gate (classifier + blacklist).
    // planExecuting only affects prompt injection and UI; it does not bypass auto.

    // PLAN: read-only except plan.md; bash allowlist only.
    if (currentMode === "plan") {
      if (PLAN_READ_TOOLS.has(tool)) {
        return undefined;
      }
      if (tool === "edit" || tool === "write") {
        const pathStr = String(input.path ?? "");
        if (pathStr && isPlanFilePath(pathStr, ctx.cwd)) {
          return undefined;
        }
        return {
          block: true,
          reason: `Plan mode: only ${shortenPath(planFilePath)} may be edited.`,
        };
      }
      if (tool === "bash") {
        const cmd = String(input.command ?? "");
        if (!isSafeCommand(cmd)) {
          return {
            block: true,
            reason: `Plan mode: read-only commands only.\n  Command: ${cmd}`,
          };
        }
      }
      return undefined;
    }

    // AUTO: tiered gate with optional classifier + user prompts for risky ops
    if (currentMode === "auto") {
      if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
        const pathStr = String(input.path ?? "");
        if (pathStr && isSensitivePath(pathStr, ctx.cwd)) {
          return promptAutoTier3(
            ctx,
            tool,
            input,
            `sensitive path "${pathStr}"`,
            "sensitive-path",
          );
        }
        return allowToolCall();
      }

      if (tool === "edit" || tool === "write") {
        const pathStr = String(input.path ?? "");
        if (pathStr && isSensitivePath(pathStr, ctx.cwd)) {
          return promptAutoTier3(
            ctx,
            tool,
            input,
            `sensitive path "${pathStr}"`,
            "sensitive-path",
          );
        }
        if (!pathStr || !isOutsideCwd(pathStr, ctx.cwd)) {
          return allowToolCall();
        }
      }

      if (tool === "bash") {
        const cmd = String(input.command ?? "");
        if (cmd && commandReferencesSensitivePath(cmd)) {
          return promptAutoTier3(
            ctx,
            tool,
            input,
            `sensitive path in command: ${cmd}`,
            "sensitive-path",
          );
        }
        // Tier 1 / Tier 2 verdicts share one splitShellSegments pass (plan A4).
        const tiers = cmd ? classifyBashTiers(cmd) : undefined;
        // Tier 1: read-only bash auto-approves.
        if (tiers?.safe) {
          return allowToolCall();
        }
        // Tier 1.5: autoMode.allow user rules short-circuit before classifier.
        // Guard: compound commands (&&, ||, ;) must have ALL segments safe,
        // preventing "npm install && rm -rf /" from being allowed by a "npm" rule.
        if (cmd && autoModeConfig?.allow?.length) {
          if (autoModeConfig.allow.some((p) => matchAutoModePattern(cmd, p))) {
            if (tiers?.autoApprovable) {
              return allowToolCall();
            }
            // Pattern matched but command has dangerous segments → fall through
          }
        }
        // Tier 1.5b: autoMode.soft_deny forces a prompt.
        if (cmd && autoModeConfig?.soft_deny?.length) {
          if (autoModeConfig.soft_deny.some((p) => matchAutoModePattern(cmd, p))) {
            return promptAutoTier3(ctx, tool, input, "matched autoMode.soft_deny", "auto-deny");
          }
        }
        // Tier 2: common dev workflow commands auto-approve without classifier.
        if (tiers?.autoApprovable) {
          return allowToolCall();
        }
      }

      return approveAutoTier3(ctx, tool, input, {
        tool,
        command: tool === "bash" ? String(input.command ?? "") : undefined,
        path:
          tool === "edit" || tool === "write"
            ? String(input.path ?? "")
            : undefined,
      });
    }

    // ASK: prompt on edit/write; prompt on read outside cwd; mutating bash prompts.
    if (currentMode === "ask") {
      if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
        const pathStr = String(input.path ?? "");
        if (pathStr && isOutsideCwd(pathStr, ctx.cwd)) {
          return promptApproval(
            ctx,
            tool,
            `outside cwd on "${pathStr}"`,
            input,
          );
        }
        return undefined;
      }
      if (tool === "edit" || tool === "write") {
        const pathVal = String(input.path ?? "(unknown)");
        if (!ctx.hasUI) {
          return promptApproval(ctx, tool, `on ${pathVal}`, input);
        }
        // The bypass switch stays ask-mode-only (CC-aligned, adjudicated
        // 2026-09-12); side effects route through the shared executor.
        const choice = await ctx.ui.select(`Allow ${tool} on ${pathVal}?`, [
          "Allow",
          "Allow always (this project)",
          "Allow always (global)",
          "Allow all (enable bypass)",
          "Block",
        ]);
        const decision: ApprovalDecision =
          choice === "Allow always (this project)"
            ? "allow_always_local"
            : choice === "Allow always (global)"
              ? "allow_always_global"
              : choice === "Allow all (enable bypass)"
                ? "bypass"
                : choice === "Allow"
                  ? "allow"
                  : "block";
        return applyApprovalDecision(ctx, tool, input, decision, {
          complianceOnBlock: false,
          blockReason: `${tool} blocked by user on ${pathVal}`,
        });
      }
      if (tool === "bash") {
        const cmd = String(input.command ?? "");
        if (isSafeCommand(cmd)) return undefined;
        return promptApproval(ctx, tool, `"${cmd}"`, input);
      }
      return undefined;
    }

    return undefined;
  });

  // ---- context injection (system prompt anchor) --------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    // Keep inherited-mode env fresh so subagents spawned this turn see the
    // parent's current mode (covers mid-session upgrades / missed setMode).
    publishInheritedPermissionMode(currentMode);
    publishCapability({ mode: currentMode });

    // Re-apply each turn so other extensions (e.g. hypa replace mode) cannot
    // permanently drop plan-mode tools like ls/grep/find from the active set.
    applyToolRestrictions();

    classifierConfig = resolveClassifierConfig(loadPermissionModesConfig());
    autoModeConfig = resolveAutoModeConfig(loadPermissionModesConfig());
    reloadMergedPermissionRules(ctx.cwd);

    const systemPromptBase =
      event?.systemPrompt ?? ctx?.getSystemPrompt?.() ?? "";

    let modeBlock = "";
    const complianceBlock = pendingComplianceInject
      ? resolveModePrompt({
          mode: currentMode,
          pendingComplianceInject: true,
          complianceCategory,
        })
      : "";

    if (planExecuting && planTodos.length) {
      const remaining = planTodos
        .filter((t) => !t.completed)
        .map((t) => `${t.step}. ${t.text}`)
        .join("\n");
      modeBlock = `[Plan/executing] Execute steps from plan.md. Remaining:\n${remaining}\nMark progress with [DONE:n] tags.`;
      planPhase = "executing";
      if (complianceBlock) modeBlock = `${modeBlock}\n${complianceBlock}`;
    } else {
      const planPath =
        currentMode === "plan" ? shortenPath(ensurePlanFile(ctx.cwd)) : undefined;
      modeBlock = resolveModePrompt({
        mode: currentMode,
        planPhase,
        planFilePath: planPath,
        needsAskReminder,
        needsBypassSecurityReminder,
        pendingComplianceInject,
        complianceCategory,
      });
    }

    if (pendingComplianceInject) {
      pendingComplianceInject = false;
      complianceCategory = "";
    }
    if (needsAskReminder) needsAskReminder = false;
    if (needsBypassSecurityReminder) needsBypassSecurityReminder = false;

    let injectionBlock = "";
    if (currentMode === "auto" || currentMode === "bypass") {
      injectionBlock = TOOL_OUTPUT_INJECTION_WARNING;
      try {
        // Real SessionEntry shape comes unwrapped from the port; the legacy
        // flat `ctx.messages` fallback predates typed access (plan B1).
        const messages = readBranchMessages(ctx.sessionManager);
        const signal = scanBranchForInjectionSignals(
          messages.length > 0 ? messages : (((ctx as any).messages ?? []) as never[]),
        );
        if (signal) {
          injectionBlock = buildInjectionWarningBlock(signal);
        }
      } catch {
        // best-effort scan only
      }
    }

    const skillFilter = resolveSkillFilter(modelProfileConfig, currentMode);
    let workingPrompt = systemPromptBase;
    if (skillFilter.length !== 1 || skillFilter[0] !== "*") {
      if (workingPrompt) {
        const filtered = filterSkillsFromPrompt(workingPrompt, skillFilter);
        if (
          skillFilter.length > 0 &&
          filtered === workingPrompt &&
          workingPrompt.includes("<skill")
        ) {
          console.warn(
            `[permission-modes] Skill filter for mode "${currentMode}" was a no-op ` +
              `(${skillFilter.length} skill(s) requested: ${skillFilter.join(", ")}).`,
          );
        }
        workingPrompt = filtered;
      }
    }

    const anchored = injectModePrompt(workingPrompt, modeBlock);
    const withInjection =
      injectionBlock && anchored
        ? `${anchored}\n\n${injectionBlock}`
        : injectionBlock && !anchored
          ? injectionBlock
          : anchored;
    if (withInjection !== workingPrompt || modeBlock || injectionBlock) {
      return { systemPrompt: withInjection || workingPrompt };
    }
    return undefined;
  });

  pi.on("context", async (event) => {
    const msgs = event.messages as any[];
    let lastIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]?.customType === "modes-context") lastIdx = i;
    }
    if (lastIdx === -1) return undefined;
    return {
      messages: msgs.filter(
        (m, i) => m?.customType !== "modes-context" || i === lastIdx,
      ),
    };
  });

  // ---- streaming-stat working message -----------------------------------
  pi.on("turn_start", async (_event, ctx) => {
    streamStart = Date.now();
    outputAtStart = computeStats(ctx).output;
    refreshWorkingMessage(ctx);
  });
  pi.on("before_provider_request", async (_event, ctx) =>
    refreshWorkingMessage(ctx),
  );
  pi.on("message_update", async (_event, ctx) => refreshWorkingMessage(ctx));

  // ---- turn_end: tps + plan-step tracking --------------------------------
  pi.on("turn_end", async (event, ctx) => {
    try {
      gitBranch = readGitBranch(ctx.sessionManager) ?? gitBranch;
    } catch {
      /* ignore */
    }

    const stats = computeStats(ctx);
    const elapsed = Math.max((Date.now() - streamStart) / 1000, 0.001);
    const delta = stats.output - outputAtStart;
    if (delta > 0) lastTps = delta / elapsed;
    refreshWorkingMessage(ctx);

    const msg = event.message;
    if (!isAssistant(msg)) return;
    const text = getText(msg);

    if (planExecuting && planTodos.length) {
      if (markCompletedSteps(text, planTodos) > 0) updatePlanWidget(ctx);
      persistState();
    }
  });

  // ---- agent_end: idle reset + plan complete + plan offer ----------------
  pi.on("agent_end", async (event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWorkingMessage();

    // Plan execution in progress: announce completion when all steps are done.
    if (planExecuting && planTodos.length) {
      if (planTodos.every((t) => t.completed)) {
        if (ctx.hasUI) {
          pi.sendMessage(
            {
              customType: "plan-complete",
              content: "**Plan Complete!** ✓",
              display: true,
            },
            { triggerTurn: false },
          );
          ctx.ui.setWidget("plan-todos", undefined);
        }
        planExecuting = false;
        planTodos = [];
        persistState();
      }
      return;
    }

    // In plan mode: sync plan.md and offer next action (throttled).
    if (currentMode !== "plan" || !ctx.hasUI || planExecuting) return;

    const planContent = readPlanFile(ctx.cwd);
    let extracted = filterSubstantivePlanItems(
      planContent ? extractTodoItems(planContent) : [],
    );

    const lastAssistant = [...(event.messages as any[])]
      .reverse()
      .find(isAssistant);
    const assistantText = lastAssistant ? getText(lastAssistant) : "";
    const assistantPlan = assistantText
      ? filterSubstantivePlanItems(extractTodoItems(assistantText))
      : [];

    if (!extracted.length && assistantPlan.length) {
      if (shouldSyncAssistantPlanToFile(planContent)) {
        const planSection = extractPlanSection(assistantText);
        if (planSection) writePlanFile(ctx.cwd, planSection);
        extracted = assistantPlan;
      }
    } else if (assistantPlan.length) {
      if (shouldSyncAssistantPlanToFile(planContent)) {
        const assistantSection = extractPlanSection(assistantText);
        if (assistantSection) writePlanFile(ctx.cwd, assistantSection);
        extracted = assistantPlan;
      }
    }

    if (!extracted.length) return;

    // Cooldown / Stay dismiss: don't re-offer within 60s of the last offer.
    if (Date.now() - lastPlanOfferAt < PLAN_OFFER_COOLDOWN_MS) return;
    if (Date.now() < suppressPlanOfferUntil) return;

    const syncedContent = readPlanFile(ctx.cwd) ?? planContent ?? "";
    const contentHash = hashPlan(
      syncedContent || JSON.stringify(extracted),
    );
    const isFirst = !lastExtractedPlanHash;
    const changed = contentHash !== lastExtractedPlanHash;
    if (!isFirst && !changed) return;

    planTodos = extracted;
    persistState();

    // Mark before await so a concurrent agent_end cannot open a second dialog.
    markPlanOfferHandled(syncedContent || JSON.stringify(extracted));
    const choice = await runPlanApprovalDialog(ctx, {
      planContent: syncedContent,
      stepCount: extracted.length,
    });
    markPlanOfferHandled(syncedContent || JSON.stringify(extracted));

    if (choice === "execute") {
      planExecuting = true;
      planPhase = "executing";
      currentMode = "auto";
      applyToolRestrictions();
      updateStatus(ctx);
      updatePlanWidget(ctx);
      persistState();
      await applyProfileModelForMode("auto", ctx);
      const steps = planTodos.map((t) => `${t.step}. ${t.text}`).join("\n");
      pi.sendMessage(
        {
          customType: "modes-execute",
          content: `Execute the plan now. Steps:\n${steps}\n\nStart with step 1. After finishing each step, include a [DONE:n] tag in your reply.`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else if (choice === "refine") {
      await promptPlanRefinement(ctx);
    }
    // stay | cancel (Esc): dialog already closed; return silently to the input prompt.
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (currentMode === "bypass") {
      needsBypassSecurityReminder = true;
    }
    persistState();
  });

  // ---- session start / resume -------------------------------------------
  async function onSessionStart(
    _event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    // Ensure the model profiles config exists (creates ~/.pi/agent if missing
    // and writes a default file with the user's default model detected from
    // settings.json). Re-runs on /reload so a user-deleted file is recreated.
    modelProfileConfig = ensureModelProfilesConfig();

    const flag = pi.getFlag("permission-mode");
    if (typeof flag === "string") {
      if ((MODE_CYCLE as string[]).includes(flag)) {
        currentMode = flag as Mode;
      } else if (flag === "default" || flag === "accept-edits") {
        currentMode = "ask";
      }
    }

    // --model-profile <name>: validate and activate the named profile.
    const profileFlag = pi.getFlag("model-profile");
    if (typeof profileFlag === "string" && profileFlag) {
      const config = loadModelProfiles();
      if (profileExists(config, profileFlag)) {
        activeProfile = profileFlag;
        modelProfileConfig = config;
      } else if (ctx.hasUI) {
        ctx.ui.notify(
          `Unknown profile "${profileFlag}". Available: ${listProfiles(config).join(", ") || "(none)"}`,
          "warning",
        );
      }
    }

    // Restore the latest persisted mode entry (overrides the flag).
    try {
      const modesData = readCustomEntryData(ctx.sessionManager, "modes");
      const last = modesData[modesData.length - 1] as
        | {
            currentMode?: string;
            planPhase?: string;
            planExecuting?: boolean;
            planTodos?: TodoItem[];
            lastExtractedPlanHash?: string;
            activeProfile?: string;
          }
        | undefined;
      if (last) {
        let m = last.currentMode;
        if (m === "normal") m = "default";      // legacy (v0.x)
        if (m === "default") m = "ask";          // v1.0.0 → v2.0.0 rename
        if (m === "accept-edits") m = "ask";
        if ((MODE_CYCLE as string[]).includes(m)) currentMode = m!;
        if (typeof last.planPhase === "string")
          planPhase = last.planPhase as PlanPhase;
        if (typeof last.planExecuting === "boolean")
          planExecuting = last.planExecuting;
        if (Array.isArray(last.planTodos))
          planTodos = last.planTodos as TodoItem[];
        if (typeof last.lastExtractedPlanHash === "string")
          lastExtractedPlanHash = last.lastExtractedPlanHash;
        if (typeof last.activeProfile === "string")
          activeProfile = last.activeProfile;
      }
    } catch {
      /* ignore */
    }

    // Headless subagents ALWAYS inherit the parent's live mode from env when
    // set (wins over --permission-mode flag and session restore). Review
    // fan-out must not stay on ask while the parent is in bypass.
    const inherited = applyInheritedModeForChild();
    if (inherited) currentMode = inherited;

    // Always publish so nested / later spawns see the effective mode.
    publishInheritedPermissionMode(currentMode);
    publishCapability({ mode: currentMode });

    classifierConfig = resolveClassifierConfig(loadPermissionModesConfig());
    autoModeConfig = resolveAutoModeConfig(loadPermissionModesConfig());
    if (currentMode === "auto") {
      classifierDenialState = createDenialTrackingState();
    }
    reloadMergedPermissionRules(ctx.cwd);

    try {
      gitBranch = readGitBranch(ctx.sessionManager) ?? "";
    } catch {
      /* ignore */
    }

    // Cache the project root once per session.
    if (projectRoot === null) {
      try {
        projectRoot = findProjectRoot(ctx.cwd);
      } catch {
        projectRoot = null;
      }
    }

    applyToolRestrictions();
    if (planExecuting && planTodos.length) updatePlanWidget(ctx);
    if (currentMode === "ask") needsAskReminder = true;
    if (currentMode === "bypass") needsBypassSecurityReminder = true;
    if (ctx.hasUI) {
      installFooter(ctx);
      updateStatus(ctx);
    }

    // If a profile was activated (via flag or persisted state), apply its
    // model mapping for the current mode.
    if (activeProfile) {
      await applyProfileModelForMode(currentMode, ctx);
    }

    startPermissionForwardingPoller(ctx);
  }

  async function handleForwardedPermissionRequest(
    ctx: ExtensionContext,
    request: ForwardedPermissionRequest,
  ): Promise<void> {
    const agentDir = defaultAgentDir();
    const name = request.requesterAgentName?.trim();
    const title = name
      ? `[Subagent ${name}] ${request.message}`
      : `[Subagent] ${request.message}`;
    const sessionId = readSessionId(ctx.sessionManager);
    // Only the targeted parent session may answer; reject mismatched inbox drain.
    if (sessionId && sessionId !== request.targetSessionId) {
      forwardingClaimedIds.delete(request.id);
      return;
    }
    const responderSessionId = request.targetSessionId;

    let decision: ForwardedDecision = "block";
    let approved = false;
    let denialReason: string | undefined = `${request.tool} blocked by user`;

    try {
      const choice = await ctx.ui.select(title, [
        "Allow",
        "Allow always (this project)",
        "Allow always (global)",
        "Block",
      ]);
      if (choice === "Allow") {
        decision = "allow";
        approved = true;
        denialReason = undefined;
      } else if (choice === "Allow always (this project)") {
        decision = "allow_always_local";
        approved = true;
        denialReason = undefined;
        await applyApprovalDecision(ctx, request.tool, request.input, "allow_always_local", {
          ruleCwd: request.cwd,
          trackWrite: false,
        });
      } else if (choice === "Allow always (global)") {
        decision = "allow_always_global";
        approved = true;
        denialReason = undefined;
        await applyApprovalDecision(ctx, request.tool, request.input, "allow_always_global", {
          ruleCwd: request.cwd,
          trackWrite: false,
        });
      }
    } catch {
      decision = "block";
      approved = false;
      denialReason = `${request.tool} blocked: parent approval cancelled`;
    }

    await writeForwardedResponse(agentDir, request.targetSessionId, {
      id: request.id,
      challenge: request.challenge,
      approved,
      decision,
      responderSessionId,
      respondedAt: new Date().toISOString(),
      ...(denialReason ? { denialReason } : {}),
    });
  }

  function startPermissionForwardingPoller(ctx: ExtensionContext): void {
    forwardingPoller?.stop();
    forwardingPoller = undefined;
    if (!ctx.hasUI || isSubagentChildProcess()) return;

    const agentDir = defaultAgentDir();
    forwardingPoller = createForwardingPoller({
      agentDir,
      hasUI: true,
      isChild: false,
      claimedIds: forwardingClaimedIds,
      getSessionId: () => readSessionId(ctx.sessionManager),
      onRequest: (request) => handleForwardedPermissionRequest(ctx, request),
    });
    forwardingPoller.start();
  }

  pi.on("session_start", onSessionStart);
  pi.on("session_tree", onSessionStart);
  pi.on("session_shutdown", () => {
    forwardingPoller?.stop();
    forwardingPoller = undefined;
    forwardingClaimedIds.clear();
  });
}
