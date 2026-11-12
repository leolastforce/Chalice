import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ActivityIndicator } from "./indicator.ts";

const STATE_ENTRY = "active-task";

export default function activeTaskExtension(pi: ExtensionAPI) {
	let text = "";
	let active = false;

	const updateWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!active || !text) {
			ctx.ui.setWidget("active-task", undefined);
			return;
		}
		const activity = text;
		ctx.ui.setWidget("active-task", (tui, theme) => new ActivityIndicator(tui, theme, activity), { placement: "aboveEditor" });
	};

	const restore = (ctx: ExtensionContext): void => {
		text = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			if (typeof entry.data === "string") text = entry.data;
		}
		updateWidget(ctx);
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("agent_start", (_event, ctx) => {
		active = true;
		updateWidget(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		active = false;
		updateWidget(ctx);
	});

	pi.registerTool({
		name: "active_task",
		label: "Active task",
		description: "Show what you are doing now as one short activity line. Setting text replaces the previous activity; an empty string clears it.",
		promptSnippet: "Show your current activity in one short line",
		promptGuidelines: [
			"Use active_task when starting meaningful work: set text to a short, concrete phrase describing what you are doing now, and replace it when your focus changes.",
			"This is an activity line, not a plan or checklist. Skip updates for trivial answers and do not update it for every tool call. The line is hidden while idle; keep the last activity until replaced, or clear it with empty text when appropriate.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "Current activity, e.g. Investigating session restoration. Empty string clears the line." }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			text = params.text.replace(/\s+/gu, " ").trim();
			pi.appendEntry(STATE_ENTRY, text);
			updateWidget(ctx);
			return {
				content: [{ type: "text", text: text || "Activity cleared" }],
				details: { text },
			};
		},
	});
}
