import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type PermissionMode = "default" | "read" | "review";

const EDITING_TOOLS = new Set(["edit", "write"]);
const READ_MODE_BLOCKED_TOOLS = new Set([
  "bash",
  "powershell",
  "edit",
  "write",
]);

interface PermissionModeState {
  mode: PermissionMode;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "default" || value === "read" || value === "review";
}
export default function permissionModesExtension(pi: ExtensionAPI): void {
  let mode: PermissionMode = "default";
  let unrestrictedTools: string[] | undefined;

  pi.registerFlag("permission-mode", {
    description: "Permission mode: default, read, or review",
    type: "string",
  });

  function toolsForMode(nextMode: PermissionMode): string[] {
    const available = unrestrictedTools ?? pi.getActiveTools();
    if (nextMode === "default") return available;
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
    pi.appendEntry<PermissionModeState>("permission-mode", { mode });
  }

  function applyMode(
    nextMode: PermissionMode,
    ctx: ExtensionContext,
    persist = true,
  ): void {
    if (nextMode !== "default" && unrestrictedTools === undefined) {
      unrestrictedTools = pi.getActiveTools();
    }
    mode = nextMode;
    pi.setActiveTools(toolsForMode(mode));
    if (mode === "default") unrestrictedTools = undefined;
    updateStatus(ctx);
    if (persist) persistMode();
  }

  function modeFromBranch(ctx: ExtensionContext): PermissionMode | undefined {
    let savedMode: PermissionMode | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "permission-mode")
        continue;
      const data = entry.data as PermissionModeState | undefined;
      if (isPermissionMode(data?.mode)) savedMode = data.mode;
    }
    return savedMode;
  }

  function requestedMode(ctx: ExtensionContext): PermissionMode {
    const flagMode = pi.getFlag("permission-mode");
    if (isPermissionMode(flagMode)) return flagMode;
    return modeFromBranch(ctx) ?? "default";
  }

  pi.registerCommand("mode", {
    description: "Set permission mode: default, read, or review",
    getArgumentCompletions: (prefix) =>
      ["default", "read", "review"]
        .filter((candidate) => candidate.startsWith(prefix.trim()))
        .map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      const requested = args.trim().split(/\s+/, 1)[0] ?? "";
      if (requested.length === 0) {
        ctx.ui.notify(
          `Permission mode: ${mode}. Available: default, read, review.`,
          "info",
        );
        return;
      }
      if (!isPermissionMode(requested)) {
        ctx.ui.notify(
          `Unknown permission mode "${requested}". Available: default, read, review.`,
          "error",
        );
        return;
      }
      applyMode(requested, ctx);
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
            : undefined;
    if (nextMode === undefined) return;

    if (nextMode !== "default" && unrestrictedTools === undefined) {
      unrestrictedTools = pi.getActiveTools();
    }
    mode = nextMode;
    pi.setActiveTools(toolsForMode(mode));
    if (mode === "default") unrestrictedTools = undefined;
    persistMode();
  });

  pi.on("session_start", async (_event, ctx) => {
    applyMode(requestedMode(ctx), ctx, false);
  });

  pi.on("session_tree", async (_event, ctx) => {
    applyMode(requestedMode(ctx), ctx, false);
  });

  pi.on("tool_call", async (event) => {
    if (mode === "default") return;
    if (mode === "review" && !EDITING_TOOLS.has(event.toolName)) return;
    if (mode === "read" && !READ_MODE_BLOCKED_TOOLS.has(event.toolName)) return;
    return {
      block: true,
      reason:
        mode === "read"
          ? "Read mode allows only non-editing tools."
          : "Review mode blocks file editing tools.",
    };
  });
}
