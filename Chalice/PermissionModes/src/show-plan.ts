/**
 * `show_plan` tool — renders a written plan Markdown file into the TUI for review.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isPlanFile, resolvePlanPath } from "./paths.ts";
import { type PlanDetails, renderPlanResult } from "./plan-render.ts";

export function createShowPlanTool(root: string): ToolDefinition {
  return {
    name: "show_plan",
    label: "Show Plan",
    promptSnippet: "Render a written plan Markdown file (plan/<date>_<description>.md) to the user for review",
    description:
      "Render a plan Markdown file to the user in the terminal for review. In Plan Mode, after writing " +
      "the plan to plan/<date>_<description>.md, call show_plan with that path. The file is shown as " +
      "formatted Markdown inline — do NOT paste the plan text into your reply.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the plan Markdown file, e.g. plan/2026-06-07_my-task.md" }),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const rel = resolvePlanPath((params as { path?: string }).path);
      if (!isPlanFile(root, rel)) {
        const msg = `show_plan only renders Markdown files under plan/. Got: ${rel || "(empty)"}`;
        return { content: [{ type: "text", text: msg }], details: { error: msg } satisfies PlanDetails };
      }
      const abs = path.resolve(root, rel);
      if (!existsSync(abs)) {
        const msg = `Plan file not found: ${rel}. Write it with the Write tool first, then call show_plan.`;
        return { content: [{ type: "text", text: msg }], details: { error: msg } satisfies PlanDetails };
      }
      const markdown = readFileSync(abs, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: `Displayed the plan (${rel}) to the user for review. They will be offered to accept it; reply with one short line asking them to review and accept it.`,
          },
        ],
        details: { markdown, path: rel } satisfies PlanDetails,
      };
    },
    renderResult(result, _opts, theme) {
      return renderPlanResult(theme, result.details as PlanDetails);
    },
  };
}
