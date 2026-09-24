import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type PermissionMode = "default" | "read" | "review" | "debug";

const EDITING_TOOLS = new Set(["edit", "write"]);
const READ_MODE_BLOCKED_TOOLS = new Set([
  "bash",
  "powershell",
  "edit",
  "write",
]);

const DEBUG_PERMISSIONS_TOOL = "DebugModeImplementingPermissions";

interface PermissionModeState {
  mode: PermissionMode;
  debugImplementingPermissions?: boolean;
}

const MODE_PROMPTS: Record<PermissionMode, string> = {
  default: `You are in Change mode. You have full tool access. Implement the user's requested changes directly using the available tools.`,
  read: `You are in Think mode. This is a read-only analysis phase. Do not modify files, run commands that can modify state, or make any other changes. If the user asks for an implementation or modification, explain that you cannot do it in Think mode and ask them to switch to Change mode. You may inspect the codebase with the available read-only tools and propose a concrete implementation plan.`,
  review: `You are in Review mode. Do not modify files or otherwise change project state, even if a mutation-capable tool is available. If the user asks for a modification, explain that Review mode is read-only and ask them to switch to Change mode. You may use the available tools to inspect the code and run tests or other validation that does not modify the project.`,
  debug: `You are in DEBUG mode. Don't modify files or otherwise change project state unless you are at the step where you implement the approved fix for the bug. Reject changes unrelated to debugging and ask to be switched to Change mode. Your job is to fix one specific bug (ask if not provided with one or multiple), with minimal changes.

Follow this sequence:
1. Reproduce the bug. Do the failing action and show the result.
2. Diagnose the root cause. Identify the file and line.
3. Propose a minimal fix. Do not refactor. Do not clean up. Wait for the user to approve the fix.
4. Once the fix is approved, call the DebugModeImplementingPermissions tool once. It grants edit, write, and unrestricted bash for the rest of Debug mode.
5. Apply the approved fix.
6. Repeat step one until the failing action succeeds (fix)

Before DebugModeImplementingPermissions has been called, edit and write are disabled and bash is non-mutating only. Blocked attempts fail - do not retry them.

Do not touch anything outside of the diagnosed problem. If you find other issues, note them but do not fix them.`,
};

const MODE_CONTEXT: Record<PermissionMode, string> = {
  default: `[CHANGE MODE ACTIVE]
You are in Change mode - full implementation mode.

You have full tool access. Implement the user's requested changes directly using the available tools.`,
  read: `[THINK MODE ACTIVE]
You are in Think mode - a read-only analysis phase.

Restrictions:
- Do not modify files or run commands that can modify state
- Do NOT call edit, write, bash, or powershell for any reason, even if the user asks. Those tools are disabled and attempts will be blocked. Do not retry blocked calls.
- If the user asks for an implementation or modification, explain you cannot do it in Think mode and ask them to switch to Change mode

You may inspect the codebase with the available read-only tools and propose a concrete implementation plan.`,
  review: `[REVIEW MODE ACTIVE]
You are in Review mode - inspection and non-mutating validation only.

Restrictions:
- Do not modify files or otherwise change project state, even if a mutation-capable tool is available
- Do NOT call edit or write for any reason, even if the user asks. Bash is restricted to non-mutating commands only. Blocked attempts will fail - do not retry them.
- If the user asks for a modification, explain Review mode is read-only and ask them to switch to Change mode

You may use the available tools to inspect the code and run tests or other validation that does not modify the project.`,
  debug: `[DEBUG MODE ACTIVE]
You are in DEBUG mode. Your job is to fix one specific bug (ask if not provided with one or multiple), with minimal changes.

Workflow:
1. Reproduce the bug. Do the failing action and show the result.
2. Diagnose the root cause. Identify the file and line.
3. Propose a minimal fix and wait for the user to approve it. Do not refactor. Do not clean up.
4. Once the fix is approved, call the DebugModeImplementingPermissions tool once. It grants edit, write, and unrestricted bash for the rest of Debug mode.
5. Apply the approved fix.
6. Repeat step one until the failing action succeeds (fix)

Restrictions:
- Do not modify files or otherwise change project state except when applying the approved fix.
- Before DebugModeImplementingPermissions has been called, edit/write are disabled and bash is non-mutating only. Blocked attempts will fail - do not retry them.
- Reject changes unrelated to debugging and ask to be switched to Change mode.

Do not touch anything outside of the diagnosed problem. If you find other issues, note them but do not fix them.`,
};

const MODE_MARKERS: Record<PermissionMode, string> = {
  default: "[CHANGE MODE ACTIVE]",
  read: "[THINK MODE ACTIVE]",
  review: "[REVIEW MODE ACTIVE]",
  debug: "[DEBUG MODE ACTIVE]",
};

const ALL_MARKERS = Object.values(MODE_MARKERS);

const REVIEW_MUTATION_PATTERNS = [
  /(?:^|[\s;&|])(?:\d*)>>?/,
  /\b(?:rm|rmdir|mv|cp|mkdir|touch|tee|truncate|install|unlink|ln)\b/i,
  /\b(?:chmod|chown|chgrp|setfacl)\b/i,
  /\b(?:sed|perl)\s+[^\n]*\s-i(?:\s|$)/i,
  /\bgit\s+(?:add|commit|clean|checkout|reset|merge|rebase|cherry-pick|revert|stash|apply|restore|switch)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|remove|update|uninstall|link|publish)\b/i,
  /\b(?:node|bun|deno|python(?:\d+)?|python3|ruby|perl)\s+(?:-[ec]|--eval|--execute)\b/i,
] as const;

function isReviewSafeBashCommand(command: string): boolean {
  return !REVIEW_MUTATION_PATTERNS.some((pattern) => pattern.test(command));
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "default" || value === "read" || value === "review" || value === "debug";
}
export default function permissionModesExtension(pi: ExtensionAPI): void {
  let mode: PermissionMode = "default";
  let unrestrictedTools: string[] | undefined;
  let debugImplementingPermissions = false;

  pi.registerFlag("permission-mode", {
    description: "Permission mode: default, read, review, or debug",
    type: "string",
  });

  pi.registerTool({
    name: DEBUG_PERMISSIONS_TOOL,
    label: "Debug Implementing Permissions",
    description:
      "Unlock implementation tools in Debug mode. Call this once, only after the user has approved your proposed minimal fix. It grants edit, write, and unrestricted bash for the rest of the Debug session. Unavailable outside Debug mode.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (mode !== "debug") {
        return {
          content: [
            { type: "text", text: "DebugModeImplementingPermissions is only available in Debug mode." },
          ],
          details: { granted: false },
        };
      }
      if (debugImplementingPermissions) {
        return {
          content: [
            {
              type: "text",
              text: "Implementation permissions are already granted. edit, write, and unrestricted bash are available.",
            },
          ],
          details: { granted: true },
        };
      }
      grantDebugImplementingPermissions(ctx);
      return {
        content: [
          {
            type: "text",
            text: "Implementation permissions granted. edit, write, and unrestricted bash are now available. Apply only the approved minimal fix.",
          },
        ],
        details: { granted: true },
      };
    },
  });

  function toolsForMode(nextMode: PermissionMode): string[] {
    const available = (unrestrictedTools ?? pi.getActiveTools()).filter(
      (toolName) => toolName !== DEBUG_PERMISSIONS_TOOL,
    );
    if (nextMode === "default") return available;
    if (nextMode === "debug") {
      const base = debugImplementingPermissions
        ? available
        : available.filter((toolName) => !EDITING_TOOLS.has(toolName));
      return [...base, DEBUG_PERMISSIONS_TOOL];
    }
    if (nextMode === "review") {
      return available.filter((toolName) => !EDITING_TOOLS.has(toolName));
    }
    return available.filter(
      (toolName) => !READ_MODE_BLOCKED_TOOLS.has(toolName),
    );
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "permission-mode",
      ctx.ui.theme.fg("accent", `mode: ${mode}`),
    );
  }

  function persistMode(): void {
    pi.appendEntry<PermissionModeState>("permission-mode", {
      mode,
      debugImplementingPermissions,
    });
  }

  function applyMode(
    state: PermissionModeState,
    ctx: ExtensionContext,
    persist = true,
  ): void {
    if (state.mode !== "default" && unrestrictedTools === undefined) {
      unrestrictedTools = pi.getActiveTools();
    }
    mode = state.mode;
    debugImplementingPermissions =
      mode === "debug" && state.debugImplementingPermissions === true;
    pi.setActiveTools(toolsForMode(mode));
    if (mode === "default") unrestrictedTools = undefined;
    updateStatus(ctx);
    if (persist) persistMode();
  }

  function grantDebugImplementingPermissions(ctx: ExtensionContext): void {
    debugImplementingPermissions = true;
    if (unrestrictedTools === undefined) {
      unrestrictedTools = pi.getAllTools().map((tool) => tool.name);
    }
    pi.setActiveTools(toolsForMode(mode));
    updateStatus(ctx);
    persistMode();
  }

  function stateFromBranch(
    ctx: ExtensionContext,
  ): PermissionModeState | undefined {
    let savedState: PermissionModeState | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "permission-mode")
        continue;
      const data = entry.data as PermissionModeState | undefined;
      if (isPermissionMode(data?.mode)) {
        savedState = {
          mode: data.mode,
          debugImplementingPermissions:
            data.debugImplementingPermissions === true,
        };
      }
    }
    return savedState;
  }

  function requestedState(ctx: ExtensionContext): PermissionModeState {
    const flagMode = pi.getFlag("permission-mode");
    const branchState = stateFromBranch(ctx);
    const requested: PermissionMode = isPermissionMode(flagMode)
      ? flagMode
      : (branchState?.mode ?? "default");
    return {
      mode: requested,
      debugImplementingPermissions:
        requested === "debug" &&
        branchState?.debugImplementingPermissions === true,
    };
  }

  pi.registerCommand("mode", {
    description: "Set permission mode: default, read, review, or debug",
    getArgumentCompletions: (prefix) =>
      ["default", "read", "review", "debug"]
        .filter((candidate) => candidate.startsWith(prefix.trim()))
        .map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      const requested = args.trim().split(/\s+/, 1)[0] ?? "";
      if (requested.length === 0) {
        ctx.ui.notify(
          `Permission mode: ${mode}. Available: default, read, review, debug.`,
          "info",
        );
        return;
      }
      if (!isPermissionMode(requested)) {
        ctx.ui.notify(
          `Unknown permission mode "${requested}". Available: default, read, review, debug.`,
          "error",
        );
        return;
      }
      applyMode({ mode: requested }, ctx);
      ctx.ui.notify(`Permission mode set to ${requested}.`, "info");
    },
  });

  pi.events.on("chalice:mode", (value) => {
    const nextMode =
      value === "Change"
        ? "default"
        : value === "Think"
          ? "read"
          : value === "Review"
            ? "review"
            : value === "Debug"
              ? "debug"
              : undefined;
    if (nextMode === undefined) return;
    // Interactive-mode already filtered tools before emitting, so only
    // capture an unrestricted baseline when the current toolset still looks
    // unfiltered. This avoids persisting a filtered list as the baseline.
    if (nextMode !== "default" && unrestrictedTools === undefined) {
      const current = pi.getActiveTools();
      const looksUnfiltered =
        nextMode === "read"
          ? [...READ_MODE_BLOCKED_TOOLS].some((tool) => current.includes(tool))
          : [...EDITING_TOOLS].some((tool) => current.includes(tool));
      if (looksUnfiltered) unrestrictedTools = current;
    }
    mode = nextMode;
    if (mode !== "debug") debugImplementingPermissions = false;
    // Enforce even if the emitter did not (e.g. non-interactive paths).
    // When baseline is unknown and tools are already filtered, this is a no-op.
    pi.setActiveTools(toolsForMode(mode));
    if (mode === "default") unrestrictedTools = undefined;
    persistMode();
  });

  pi.on("session_start", async (_event, ctx) => {
    applyMode(requestedState(ctx), ctx, false);
  });

  pi.on("session_tree", async (_event, ctx) => {
    applyMode(requestedState(ctx), ctx, false);
  });
  pi.on("tool_call", async (event) => {
    if (event.toolName === DEBUG_PERMISSIONS_TOOL) {
      if (mode === "debug") return;
      return {
        block: true,
        terminate: true,
        reason:
          "DebugModeImplementingPermissions is only available in Debug mode. Do not retry this call.",
      };
    }
    if (mode === "default" || (mode === "debug" && debugImplementingPermissions))
      return;
    if (mode === "read" && !READ_MODE_BLOCKED_TOOLS.has(event.toolName)) return;
    if (
      (mode === "review" || mode === "debug") &&
      event.toolName !== "bash" &&
      !EDITING_TOOLS.has(event.toolName)
    ) {
      return;
    }
    if ((mode === "review" || mode === "debug") && event.toolName === "bash") {
      const command =
        typeof event.input.command === "string" ? event.input.command : "";
      if (isReviewSafeBashCommand(command)) return;
    }
    return {
      block: true,
      terminate: true,
      reason:
        mode === "read"
          ? "Think mode: edit/write/bash/powershell are disabled. Do not retry this call. Explain you cannot modify in Think mode and ask to switch to Change mode."
          : mode === "debug"
            ? "Debug mode: edit/write are disabled and bash is non-mutating only until DebugModeImplementingPermissions is called. Do not retry this call. Propose the minimal fix and call DebugModeImplementingPermissions after the user approves it."
            : "Review mode: edit/write are disabled and bash is non-mutating only. Do not retry this call. Ask to switch to Change mode to modify project state.",
    };
  });
  pi.on("before_agent_start", async (event) => {
    event.systemPromptOptions.promptGuidelines = [
      ...(event.systemPromptOptions.promptGuidelines ?? []),
      MODE_PROMPTS[mode],
    ];
    // Make tool absence explicit in the prompt itself: an explicit
    // selectedTools edit wins over the live loadout, so the <tools> section
    // never advertises blocked tools for this run.
    event.systemPromptOptions.selectedTools = toolsForMode(mode);
    return {
      message: {
        customType: "permission-mode-context",
        content: MODE_CONTEXT[mode],
        display: false,
      },
    };
  });

  // Keep exactly one mode banner in context: strip stale markers from other
  // modes and re-assert the current one on every LLM call. This covers
  // mid-run mode switches: prepareNextTurn reuses the run's prompt options
  // without re-firing before_agent_start, so the banner in context is what
  // keeps the model oriented (and keeps it from retrying blocked tools).
  pi.on("context", async (event) => {
    const currentMarker = MODE_MARKERS[mode];
    const staleMarkers = ALL_MARKERS.filter((marker) => marker !== currentMarker);
    let foundCurrent = false;

    const messages = event.messages.filter((m) => {
      const msg = m as { customType?: string; role?: string; content?: unknown };
      if (msg.customType === "permission-mode-context") {
        const content = typeof msg.content === "string" ? msg.content : undefined;
        if (content !== undefined) {
          if (staleMarkers.some((marker) => content.includes(marker))) return false;
          if (content.includes(currentMarker)) foundCurrent = true;
          return true;
        }
        return true;
      }
      if (msg.role !== "user") return true;

      const content = msg.content;
      if (typeof content === "string") {
        return !staleMarkers.some((marker) => content.includes(marker));
      }
      if (Array.isArray(content)) {
        return !content.some(
          (c) =>
            typeof c === "object" &&
            c !== null &&
            "type" in c &&
            (c as { type?: string }).type === "text" &&
            "text" in c &&
            typeof (c as { text?: unknown }).text === "string" &&
            staleMarkers.some((marker) => (c as { text: string }).text.includes(marker)),
        );
      }
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
