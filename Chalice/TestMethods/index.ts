import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TEST_METHODS_ENTRY_TYPE = "session-test-methods";
const TEST_METHODS_FILE_NAME = "TESTMETHODS.md";

interface SessionTestMethodsEntry {
  prompt?: string;
  enabled?: boolean;
}

interface TestMethodsState {
  prompt?: string;
  enabled: boolean;
}

function readSessionState(ctx: ExtensionContext): TestMethodsState {
  let prompt: string | undefined;
  let enabled = true;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== TEST_METHODS_ENTRY_TYPE) continue;

    const data = entry.data as SessionTestMethodsEntry | undefined;
    if (typeof data?.prompt === "string") prompt = data.prompt;
    if (typeof data?.enabled === "boolean") enabled = data.enabled;
  }

  return { prompt, enabled };
}

function readProjectTestMethods(ctx: ExtensionContext): string | undefined {
  const path = join(ctx.cwd, TEST_METHODS_FILE_NAME);
  if (!existsSync(path)) return undefined;

  try {
    const content = readFileSync(path, "utf8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

export default function testMethodsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("testprompt", {
    description: "Sets the test-method prompt for the session",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /testprompt <prompt>", "info");
        return;
      }

      pi.appendEntry<SessionTestMethodsEntry>(TEST_METHODS_ENTRY_TYPE, { prompt, enabled: true });
      ctx.ui.notify(`Test-method prompt set: ${prompt}`, "info");
    },
  });

  pi.registerCommand("testmethods", {
    description: "Enables or disables test-method prompting for the session",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value !== "true" && value !== "false") {
        ctx.ui.notify("Usage: /testmethods true|false", "info");
        return;
      }

      const enabled = value === "true";
      pi.appendEntry<SessionTestMethodsEntry>(TEST_METHODS_ENTRY_TYPE, { enabled });
      ctx.ui.notify(`Test-method prompting ${enabled ? "enabled" : "disabled"} for this session`, "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = readSessionState(ctx);
    if (!state.enabled) return;

    const projectMethods = readProjectTestMethods(ctx);
    if (!projectMethods && !state.prompt) return;

    const sources = [
      projectMethods ? `Project test methods (from ${TEST_METHODS_FILE_NAME}):\n${projectMethods}` : undefined,
      state.prompt ? `Session test-method prompt:\n${state.prompt}` : undefined,
    ].filter((source): source is string => source !== undefined);

    event.systemPromptOptions.promptGuidelines = [
      ...(event.systemPromptOptions.promptGuidelines ?? []),
      `Test methods and testing requirements:\n\n${sources.join("\n\n")}`,
    ];
  });
}
