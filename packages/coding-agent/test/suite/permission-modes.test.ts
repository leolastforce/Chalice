import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import permissionModesExtension from "../../../../Chalice/PermissionModes/src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function bannerInMessages(harness: Harness, marker: string): boolean {
	return harness.session.messages.some((message) => {
		const entry = message as { customType?: string; content?: unknown };
		if (entry.customType !== "permission-mode-context") return false;
		return typeof entry.content === "string" && entry.content.includes(marker);
	});
}

function toolResultText(harness: Harness): string {
	const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
	if (!toolResult || toolResult.role !== "toolResult") return "";
	return toolResult.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("PermissionModes extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function createRecordingTools(cwdHolder: { cwd: string }, executed: string[]): AgentTool[] {
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Run a shell command",
			parameters: Type.Object({ command: Type.String() }),
			execute: async (_toolCallId, params) => {
				const command = String((params as { command?: unknown }).command ?? "");
				executed.push(`bash:${command}`);
				const match = /touch\s+([^\s;|&]+)/.exec(command);
				if (match?.[1]) writeFileSync(join(cwdHolder.cwd, match[1]), "created\n");
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const editTool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Edit a file",
			parameters: Type.Object({ path: Type.String(), content: Type.Optional(Type.String()) }),
			execute: async (_toolCallId, params) => {
				const filePath = String((params as { path?: unknown }).path ?? "");
				const content = String((params as { content?: unknown }).content ?? "edited\n");
				executed.push(`edit:${filePath}`);
				writeFileSync(join(cwdHolder.cwd, filePath), content);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const writeTool: AgentTool = {
			name: "write",
			label: "Write",
			description: "Write a file",
			parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			execute: async (_toolCallId, params) => {
				const filePath = String((params as { path?: unknown }).path ?? "");
				const content = String((params as { content?: unknown }).content ?? "");
				executed.push(`write:${filePath}`);
				writeFileSync(join(cwdHolder.cwd, filePath), content);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		return [bashTool, editTool, writeTool];
	}

	it("applies edits directly in YOLO mode and injects the YOLO banner", async () => {
		const cwdHolder = { cwd: "" };
		const executed: string[] = [];
		const seenPrompts: string[] = [];
		const harness = await createHarness({
			tools: createRecordingTools(cwdHolder, executed),
			extensionFactories: [
				permissionModesExtension,
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						seenPrompts.push(event.systemPrompt);
					});
				},
			],
		});
		harnesses.push(harness);
		cwdHolder.cwd = harness.tempDir;

		await harness.session.prompt("/mode yolo");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "hello world\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done writing"),
		]);

		await harness.session.prompt("Write hello.txt");

		expect(executed).toEqual(["write:hello.txt"]);
		expect(harness.session.getActiveToolNames()).toContain("write");
		expect(readFileSync(join(harness.tempDir, "hello.txt"), "utf8")).toBe("hello world\n");
		expect(seenPrompts.some((prompt) => prompt.includes("You are in YOLO mode"))).toBe(true);
		expect(bannerInMessages(harness, "[YOLO MODE ACTIVE]")).toBe(true);
	});

	it("activates Ask mode and injects the Ask banner", async () => {
		const harness = await createHarness({ extensionFactories: [permissionModesExtension] });
		harnesses.push(harness);

		await harness.session.prompt("/mode ask");
		harness.setResponses([fauxAssistantMessage("Ready")]);
		await harness.session.prompt("Check my permissions");

		expect(bannerInMessages(harness, "[ASK MODE ACTIVE]")).toBe(true);
	});

	it("blocks non-markdown edits in Plan mode and injects the Plan banner", async () => {
		const cwdHolder = { cwd: "" };
		const executed: string[] = [];
		const seenPrompts: string[] = [];
		const harness = await createHarness({
			tools: createRecordingTools(cwdHolder, executed),
			extensionFactories: [
				permissionModesExtension,
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						seenPrompts.push(event.systemPrompt);
					});
				},
			],
		});
		harnesses.push(harness);
		cwdHolder.cwd = harness.tempDir;

		await harness.session.prompt("/mode plan");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: "fish" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Could not edit"),
		]);

		await harness.session.prompt("Edit the fish file");

		expect(executed).toEqual([]);
		expect(toolResultText(harness)).toContain("Plan allows editing Markdown files only");
		expect(
			seenPrompts.some(
				(prompt) => prompt.includes("Plan Mode is active") || prompt.includes("You are in Plan mode"),
			),
		).toBe(true);
		expect(bannerInMessages(harness, "[PLAN MODE ACTIVE]")).toBe(true);
	});

	it("does not expose the removed Debug mode", async () => {
		const harness = await createHarness({ extensionFactories: [permissionModesExtension] });
		harnesses.push(harness);
		const activeToolNames = harness.session.getActiveToolNames();
		await harness.session.prompt("/mode debug");
		expect(harness.session.getActiveToolNames()).toEqual(activeToolNames);
		expect(harness.session.getActiveToolNames()).not.toContain("DebugModeImplementingPermissions");
	});

	it("preserves user messages containing mode markers across mode switches", async () => {
		const harness = await createHarness({
			extensionFactories: [permissionModesExtension],
		});
		harnesses.push(harness);

		await harness.session.prompt("/mode plan");
		harness.setResponses([fauxAssistantMessage("thinking done")]);
		await harness.session.prompt("Analyze this while in [PLAN MODE ACTIVE]");

		await harness.session.prompt("/mode yolo");
		let contextMessages: unknown[] = [];
		harness.setResponses([
			(context) => {
				contextMessages = [...context.messages];
				return fauxAssistantMessage("auto done");
			},
		]);
		await harness.session.prompt("Now implement the change");

		const hasOriginalPrompt = contextMessages.some((msg) => {
			const content = (msg as { content?: unknown })?.content;
			if (typeof content === "string") return content.includes("Analyze this while in [PLAN MODE ACTIVE]");
			if (Array.isArray(content)) {
				return content.some(
					(c) =>
						typeof c === "object" &&
						c !== null &&
						"text" in c &&
						(c as { text: string }).text.includes("Analyze this while in [PLAN MODE ACTIVE]"),
				);
			}
			return false;
		});
		expect(hasOriginalPrompt).toBe(true);
	});
});
