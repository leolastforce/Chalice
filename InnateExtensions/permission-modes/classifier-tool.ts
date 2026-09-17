/**
 * CC classify_result tool schema for auto-mode classifier (tool stage).
 */

import { Type } from "@earendil-works/pi-ai"
import type { Tool } from "@earendil-works/pi-ai/compat"

export const CLASSIFIER_TOOL_NAME = "classify_result"

export const classifierResultTool: Tool = {
	name: CLASSIFIER_TOOL_NAME,
	description:
		"Report the security classification result for the agent action",
	parameters: Type.Object({
		thinking: Type.String({
			description: "Brief step-by-step reasoning.",
		}),
		shouldBlock: Type.Boolean({
			description:
				"Whether the action should be blocked (true) or allowed (false)",
		}),
		reason: Type.String({
			description: "Brief explanation of the classification decision",
		}),
	}),
}
