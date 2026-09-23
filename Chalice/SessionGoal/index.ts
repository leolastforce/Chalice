import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const GOAL_ENTRY_TYPE = "session-goal";

interface SessionGoalEntry {
  goal: string;
}

function readSessionGoal(ctx: ExtensionContext): string | undefined {
  let goal: string | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) continue;
    const data = entry.data as SessionGoalEntry | undefined;
    if (typeof data?.goal === "string") goal = data.goal;
  }
  return goal;
}

export default function sessionGoalExtension(pi: ExtensionAPI): void {
  pi.registerCommand("goal", {
    description: "Sets the goal for the session, (instruction field), you can change it whenever.",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /goal <text>", "info");
        return;
      }

      pi.appendEntry<SessionGoalEntry>(GOAL_ENTRY_TYPE, { goal });
      ctx.ui.notify(`Session goal set: ${goal}`, "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const goal = readSessionGoal(ctx);
    if (!goal) return;

    event.systemPromptOptions.promptGuidelines = [
      ...(event.systemPromptOptions.promptGuidelines ?? []),
      `Session goal: ${goal}`,
    ];
  });
}
