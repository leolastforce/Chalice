import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showResultApproval } from "./approval-ui.ts";
import { ConfirmWorkspace, WorkspaceConflictError } from "./workspace.ts";

export type PermissionMode = "auto" | "think" | "confirm" | "debug";

const EDITING_TOOLS = new Set(["edit", "write"]);
const THINK_BLOCKED_TOOLS = new Set(["bash", "powershell", "edit", "write"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "anchor_grep", "find", "ls"]);
const DEBUG_PERMISSIONS_TOOL = "DebugModeImplementingPermissions";

interface PermissionModeState {
  mode: PermissionMode;
  debugImplementingPermissions?: boolean;
}

const MODE_PROMPTS: Record<PermissionMode, string> = {
  auto: "You are in Auto mode. You have full tool access and project edits are applied directly.",
  think: "You are in Think mode. This is a read-only analysis phase. Do not modify files or run commands that can modify state. If the user asks for an implementation or modification, explain that you cannot do it in Think mode and ask them to switch to Auto or Confirm mode. You may inspect the codebase and propose a concrete implementation plan.",
  confirm: "You are in Confirm mode. Make requested project changes in the isolated workspace. When your response settles, the user reviews the complete workspace diff and chooses Approve Result or Deny Result. Do not claim the original workspace was changed before approval.",
  debug: `You are in Debug mode. Fix one specific bug with minimal changes. All edits use an isolated workspace and require final approval after your response.

Follow this sequence:
1. Reproduce the bug and show the failing result.
2. Diagnose the root cause. Identify the file and line.
3. Propose a minimal fix. Do not refactor or clean up. Wait for the user to approve the proposed fix.
4. Once the fix is approved, call the DebugModeImplementingPermissions tool once. This grants edit, write, and unrestricted bash for the rest of Debug mode.
5. Apply only the approved fix in the isolated workspace.
6. Repeat step one until the failing action succeeds.

Before DebugModeImplementingPermissions has been called, edit and write are disabled and bash is restricted to non-mutating commands. Blocked attempts fail; do not retry them.

After the response settles, the user separately approves or denies applying the complete staged diff. Do not touch anything outside the diagnosed problem. If you find other issues, note them but do not fix them.`,
};

const MODE_CONTEXT: Record<PermissionMode, string> = {
  auto: `[AUTO MODE ACTIVE]\nYou are in Auto mode. You have full tool access and project edits are applied directly.`,
  think: `[THINK MODE ACTIVE]\nYou are in Think mode - a read-only analysis phase.\n\nRestrictions:\n- Do not modify files or run commands that can modify state\n- Do not call edit, write, bash, or powershell. Those tools are disabled and attempts will be blocked.\n- If the user asks for an implementation, explain you cannot modify files in Think mode and ask them to switch to Auto or Confirm mode\n\nYou may inspect the codebase and propose a concrete implementation plan.`,
  confirm: `[CONFIRM MODE ACTIVE]\nYou are in Confirm mode. File changes, including changes made by shell commands, are made in an isolated workspace. The original workspace remains unchanged until the user selects Approve Result. Denied or unreviewable results are discarded.`,
  debug: `[DEBUG MODE ACTIVE]\nYou are in Debug mode. Reproduce one specific bug, diagnose its cause, propose the minimal fix, and wait for the user's approval before applying it.\n\nEdit and write remain disabled, and bash is restricted to non-mutating commands, until DebugModeImplementingPermissions is called. Once unlocked, changes still go to an isolated workspace and require the final Approve Result / Deny Result decision. Do not fix unrelated issues.`,
};

const MODE_MARKERS: Record<PermissionMode, string> = {
  auto: "[AUTO MODE ACTIVE]",
  think: "[THINK MODE ACTIVE]",
  confirm: "[CONFIRM MODE ACTIVE]",
  debug: "[DEBUG MODE ACTIVE]",
};
const ALL_MARKERS = Object.values(MODE_MARKERS);

const DEBUG_MUTATION_PATTERNS = [
  /(?:^|[\s;&|])(?:\d*)>>?/,
  /\b(?:rm|rmdir|mv|cp|mkdir|touch|tee|truncate|install|unlink|ln)\b/i,
  /\b(?:chmod|chown|chgrp|setfacl)\b/i,
  /\b(?:sed|perl)\s+[^\n]*\s-i(?:\s|$)/i,
  /\bgit\s+(?:add|commit|clean|checkout|reset|merge|rebase|cherry-pick|revert|stash|apply|restore|switch)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|remove|update|uninstall|link|publish)\b/i,
  /\b(?:node|bun|deno|python(?:\d+)?|python3|ruby|perl)\s+(?:-[ec]|--eval|--execute)\b/i,
] as const;

function isDebugSafeBashCommand(command: string): boolean {
  return !DEBUG_MUTATION_PATTERNS.some((pattern) => pattern.test(command));
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "auto" || value === "think" || value === "confirm" || value === "debug";
}

function displayMode(value: unknown): PermissionMode | undefined {
  if (value === "Auto") return "auto";
  if (value === "Think") return "think";
  if (value === "Confirm") return "confirm";
  if (value === "Debug") return "debug";
  return undefined;
}

function workspaceErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conflictMessage(paths: string[]): string {
  const shown = paths.slice(0, 8).join(", ");
  return `Result not applied: the original workspace changed while the agent was working${shown ? ` (${shown}${paths.length > 8 ? ", …" : ""})` : ""}. The staged changes were discarded.`;
}

export default function permissionModesExtension(pi: ExtensionAPI): void {
  let mode: PermissionMode = "auto";
  let unrestrictedTools: string[] | undefined;
  let debugImplementingPermissions = false;
  let runMode: PermissionMode | undefined;
  let workspace: ConfirmWorkspace | undefined;
  let workspaceFailure: string | undefined;

  pi.registerFlag("permission-mode", {
    description: "Permission mode: auto, think, confirm, or debug",
    type: "string",
  });

  pi.registerTool({
    name: DEBUG_PERMISSIONS_TOOL,
    label: "Debug Implementing Permissions",
    description:
      "Unlock edit and write tools plus unrestricted bash in Debug mode, once the user approves the proposed minimal fix. Final workspace changes still require the user's Approve Result decision.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (mode !== "debug") {
        return {
          content: [{ type: "text", text: "DebugModeImplementingPermissions is only available in Debug mode." }],
          details: { granted: false },
        };
      }
      if (debugImplementingPermissions) {
        return {
          content: [{ type: "text", text: "Implementation permissions are already granted. Changes remain staged for final approval." }],
          details: { granted: true },
        };
      }
      grantDebugImplementingPermissions(ctx);
      return {
        content: [{ type: "text", text: "Implementation permissions granted. Apply only the approved minimal fix; the final diff still requires user approval." }],
        details: { granted: true },
      };
    },
  });

  function captureAvailableTools(): void {
    if (unrestrictedTools === undefined) {
      unrestrictedTools = pi.getActiveTools().filter((toolName) => toolName !== DEBUG_PERMISSIONS_TOOL);
    }
  }

  function toolsForMode(nextMode: PermissionMode): string[] {
    const available = (unrestrictedTools ?? pi.getActiveTools()).filter(
      (toolName) => toolName !== DEBUG_PERMISSIONS_TOOL,
    );
    if (nextMode === "auto" || nextMode === "confirm") return available;
    if (nextMode === "debug") {
      const base = debugImplementingPermissions
        ? available
        : available.filter((toolName) => !EDITING_TOOLS.has(toolName));
      return [...base, DEBUG_PERMISSIONS_TOOL];
    }
    return available.filter((toolName) => !THINK_BLOCKED_TOOLS.has(toolName));
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "permission-mode",
      mode === "auto" ? undefined : ctx.ui.theme.fg("accent", `mode: ${mode}`),
    );
    pi.events.emit("chalice:mode-state", mode);
  }

  function persistMode(): void {
    pi.appendEntry<PermissionModeState>("permission-mode", {
      mode,
      debugImplementingPermissions,
    });
  }

  function applyMode(state: PermissionModeState, ctx: ExtensionContext, persist = true): void {
    captureAvailableTools();
    mode = state.mode;
    debugImplementingPermissions = mode === "debug" && state.debugImplementingPermissions === true;
    pi.setActiveTools(toolsForMode(mode));
    updateStatus(ctx);
    if (persist) persistMode();
  }

  function grantDebugImplementingPermissions(ctx: ExtensionContext): void {
    debugImplementingPermissions = true;
    if (unrestrictedTools === undefined) {
      unrestrictedTools = pi.getAllTools()
        .map((tool) => tool.name)
        .filter((toolName) => toolName !== DEBUG_PERMISSIONS_TOOL);
    }
    pi.setActiveTools(toolsForMode(mode));
    updateStatus(ctx);
    persistMode();
  }

  function stateFromBranch(ctx: ExtensionContext): PermissionModeState | undefined {
    let savedState: PermissionModeState | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "permission-mode") continue;
      const data = entry.data as PermissionModeState | undefined;
      if (isPermissionMode(data?.mode)) {
        savedState = {
          mode: data.mode,
          debugImplementingPermissions: data.debugImplementingPermissions === true,
        };
      }
    }
    return savedState;
  }

  function requestedState(ctx: ExtensionContext): PermissionModeState {
    const flagMode = pi.getFlag("permission-mode");
    const branchState = stateFromBranch(ctx);
    const requested = isPermissionMode(flagMode) ? flagMode : (branchState?.mode ?? "auto");
    return {
      mode: requested,
      debugImplementingPermissions:
        requested === "debug" && branchState?.debugImplementingPermissions === true,
    };
  }

  function setMode(nextMode: PermissionMode, ctx: ExtensionContext): void {
    captureAvailableTools();
    mode = nextMode;
    if (mode !== "debug") debugImplementingPermissions = false;
    pi.setActiveTools(toolsForMode(mode));
    updateStatus(ctx);
    persistMode();
  }

  async function startWorkspace(ctx: ExtensionContext): Promise<void> {
    if (workspace || workspaceFailure) return;
    try {
      workspace = await ConfirmWorkspace.create(ctx.cwd);
      ctx.setExecutionCwdOverride?.(workspace.workingDirectory);
    } catch (error) {
      workspaceFailure = workspaceErrorText(error);
      if (ctx.hasUI) ctx.ui.notify(`Could not create an isolated Confirm workspace: ${workspaceFailure}`, "error");
    }
  }

  async function discardWorkspace(ctx: ExtensionContext): Promise<void> {
    const current = workspace;
    workspace = undefined;
    workspaceFailure = undefined;
    ctx.setExecutionCwdOverride?.(undefined);
    if (current) await current.discard();
  }

  pi.registerCommand("mode", {
    description: "Set permission mode: auto, think, confirm, or debug",
    getArgumentCompletions: (prefix) =>
      (["auto", "think", "confirm", "debug"] as const)
        .filter((candidate) => candidate.startsWith(prefix.trim().toLowerCase()))
        .map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
      if (!requested) {
        ctx.ui.notify(`Permission mode: ${mode}. Available: auto, think, confirm, debug.`, "info");
        return;
      }
      if (!isPermissionMode(requested)) {
        ctx.ui.notify(`Unknown permission mode "${requested}". Available: auto, think, confirm, debug.`, "error");
        return;
      }
      setMode(requested, ctx);
      ctx.ui.notify(`Permission mode set to ${requested}.`, "info");
    },
  });

  pi.events.on("chalice:mode", (value) => {
    const nextMode = displayMode(value);
    if (!nextMode) return;
    captureAvailableTools();
    mode = nextMode;
    if (mode !== "debug") debugImplementingPermissions = false;
    pi.setActiveTools(toolsForMode(mode));
    persistMode();
    pi.events.emit("chalice:mode-state", mode);
  });

  pi.on("session_start", async (_event, ctx) => {
    workspace = undefined;
    workspaceFailure = undefined;
    ctx.setExecutionCwdOverride?.(undefined);
    captureAvailableTools();
    applyMode(requestedState(ctx), ctx, false);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await discardWorkspace(ctx);
    applyMode(requestedState(ctx), ctx, false);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await discardWorkspace(ctx);
  });

  pi.on("agent_start", () => {
    runMode = mode;
  });

  pi.on("tool_call", async (event, ctx) => {
    const activeMode = runMode ?? mode;

    if (event.toolName === DEBUG_PERMISSIONS_TOOL) {
      if (activeMode === "debug") return;
      return {
        block: true,
        terminate: true,
        reason: "DebugModeImplementingPermissions is only available in Debug mode. Do not retry this call.",
      };
    }

    if (activeMode === "think" && !THINK_BLOCKED_TOOLS.has(event.toolName)) return;

    if (activeMode === "think") {
      return {
        block: true,
        terminate: true,
        reason: "Think mode is read-only: bash, powershell, edit, and write are disabled. Do not retry the blocked call; explain that file changes require Auto or Confirm mode.",
      };
    }

    if (activeMode === "debug" && !debugImplementingPermissions && event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (!isDebugSafeBashCommand(command)) {
        return {
          block: true,
          terminate: true,
          reason: "Debug mode: bash is restricted to non-mutating commands until the user approves the proposed fix and DebugModeImplementingPermissions is called. Do not retry; propose the minimal fix first.",
        };
      }
    }

    const requiresIsolation =
      workspace !== undefined ||
      workspaceFailure !== undefined ||
      activeMode === "confirm" ||
      activeMode === "debug";
    if (!requiresIsolation || READ_ONLY_TOOLS.has(event.toolName)) return;

    if (workspaceFailure) {
      return {
        block: true,
        terminate: true,
        reason: `The isolated workspace could not be created: ${workspaceFailure}. No project changes were run. Do not retry this call.`,
      };
    }

    await startWorkspace(ctx);
    if (workspaceFailure) {
      return {
        block: true,
        terminate: true,
        reason: `The isolated workspace could not be created: ${workspaceFailure}. No project changes were run. Do not retry this call.`,
      };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    runMode = undefined;
    const current = workspace;
    if (!current) {
      workspaceFailure = undefined;
      return;
    }

    try {
      const review = await current.review();
      if (review.conflicts.length > 0) {
        ctx.ui.notify(conflictMessage(review.conflicts), "warning");
        return;
      }
      if (review.changes.length === 0) return;
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("Result denied: Confirm and Debug require an interactive review. The isolated workspace was discarded.", "warning");
        return;
      }

      const approved = await showResultApproval(ctx, review.changes.length, review.diff);
      if (!approved) {
        ctx.ui.notify("Denied Result. Staged changes were discarded.", "info");
        return;
      }

      const result = await current.apply();
      if (result.conflicts.length > 0) {
        ctx.ui.notify(conflictMessage(result.conflicts), "warning");
        return;
      }
      ctx.ui.notify(`Approved Result. Applied ${result.applied.length} changed workspace path${result.applied.length === 1 ? "" : "s"}.`, "info");
    } catch (error) {
      const message = error instanceof WorkspaceConflictError
        ? conflictMessage(error.paths)
        : `Result not applied: ${workspaceErrorText(error)}. Staged changes were discarded.`;
      ctx.ui.notify(message, "error");
    } finally {
      await discardWorkspace(ctx).catch((error: unknown) => {
        ctx.ui.notify(`Could not remove the temporary workspace: ${workspaceErrorText(error)}`, "warning");
      });
    }
  });

  pi.on("before_agent_start", async (event) => {
    event.systemPromptOptions.promptGuidelines = [
      ...(event.systemPromptOptions.promptGuidelines ?? []),
      MODE_PROMPTS[mode],
    ];
    event.systemPromptOptions.selectedTools = toolsForMode(mode);
    return {
      message: {
        customType: "permission-mode-context",
        content: MODE_CONTEXT[mode],
        display: false,
      },
    };
  });

  pi.on("context", async (event) => {
    const currentMarker = MODE_MARKERS[mode];
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
        content: MODE_CONTEXT[mode],
        display: false,
      } as typeof messages[number]);
    }
    return { messages };
  });
}
