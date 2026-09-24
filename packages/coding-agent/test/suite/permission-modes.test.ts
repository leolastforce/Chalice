import { existsSync, writeFileSync } from "node:fs";
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
				if (match?.[1]) writeFileSync(join(cwdHolder.cwd, match[1]), "");
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const editTool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Edit a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_toolCallId, params) => {
				executed.push(`edit:${String((params as { path?: unknown }).path ?? "")}`);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const writeTool: AgentTool = {
			name: "write",
			label: "Write",
			description: "Write a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_toolCallId, params) => {
				executed.push(`write:${String((params as { path?: unknown }).path ?? "")}`);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		return [bashTool, editTool, writeTool];
	}

	it("blocks touch fish in Review mode and injects the Review prompt", async () => {
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

		await harness.session.prompt("/mode review");
		expect(harness.session.getActiveToolNames().sort()).toEqual(["bash"]);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "touch fish" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(`second turn saw: ${text}`);
			},
		]);

		await harness.session.prompt("Make a new file called fish");

		expect(executed).toEqual([]);
		expect(existsSync(join(harness.tempDir, "fish"))).toBe(false);
		const text = toolResultText(harness);
		expect(text).toContain("Review mode");
		expect(text).toContain("Do not retry");
		expect(seenPrompts.some((prompt) => prompt.includes("You are in Review mode"))).toBe(true);
		expect(bannerInMessages(harness, "[REVIEW MODE ACTIVE]")).toBe(true);
	});

	it("removes edit in Think mode so the call fails before execution", async () => {
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

		await harness.session.prompt("/mode read");
		expect(harness.session.getActiveToolNames()).toEqual([]);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: "fish" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(`second turn saw: ${text}`);
			},
		]);

		await harness.session.prompt("Edit the fish file");

		expect(executed).toEqual([]);
		// Removed tools never reach the tool_call gate; the loop reports them missing.
		expect(toolResultText(harness)).toContain("Tool edit not found");
		expect(seenPrompts.some((prompt) => prompt.includes("You are in Think mode"))).toBe(true);
		expect(bannerInMessages(harness, "[THINK MODE ACTIVE]")).toBe(true);
	});

	it("restores full tools and swaps to the Change banner back in Change mode", async () => {
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

		await harness.session.prompt("/mode review");
		await harness.session.prompt("/mode default");

		expect(harness.session.getActiveToolNames().sort()).toEqual(["bash", "edit", "write"]);

		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("Hello");

		expect(seenPrompts.some((prompt) => prompt.includes("You are in Change mode"))).toBe(true);
		expect(bannerInMessages(harness, "[CHANGE MODE ACTIVE]")).toBe(true);
		expect(bannerInMessages(harness, "[REVIEW MODE ACTIVE]")).toBe(false);
		expect(bannerInMessages(harness, "[THINK MODE ACTIVE]")).toBe(false);
	});

	it("enables full tools and injects the DEBUG instructions in Debug mode", async () => {
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

		await harness.session.prompt("/mode debug");
		expect(harness.session.getActiveToolNames().sort()).toEqual(["bash", "edit", "write"]);

		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("Fix this bug");

		expect(seenPrompts.some((prompt) => prompt.includes("You are in DEBUG mode."))).toBe(true);
		expect(seenPrompts.some((prompt) => prompt.includes("1. Reproduce the bug."))).toBe(true);
		expect(bannerInMessages(harness, "[DEBUG MODE ACTIVE]")).toBe(true);
		expect(bannerInMessages(harness, "[CHANGE MODE ACTIVE]")).toBe(false);
	});
});
