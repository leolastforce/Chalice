import type { InlineExtension } from "../core/extensions/types.ts";
import { createCodemodeExtension } from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{
		name: "codemode",
		factory: createCodemodeExtension({ excludeTools: ["mcpScript"] }),
		replaceable: true,
		builtin: true,
	},
];
