import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
			execute: async (_toolCallId: string, params: any, _signal?: any, _onUpdate?: any, ctx?: any) => {
				const command = String((params as { command?: unknown }).command ?? "");
				executed.push(`bash:${command}`);
				const match = /touch\s+([^\s;|&]+)/.exec(command);
				if (match?.[1]) writeFileSync(join(ctx?.cwd ?? cwdHolder.cwd, match[1]), "created\n");
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const editTool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Edit a file",
			parameters: Type.Object({ path: Type.String(), content: Type.Optional(Type.String()) }),
			execute: async (_toolCallId: string, params: any, _signal?: any, _onUpdate?: any, ctx?: any) => {
				const filePath = String((params as { path?: unknown }).path ?? "");
				const content = String((params as { content?: unknown }).content ?? "edited\n");
				executed.push(`edit:${filePath}`);
				writeFileSync(join(ctx?.cwd ?? cwdHolder.cwd, filePath), content);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const writeTool: AgentTool = {
			name: "write",
			label: "Write",
			description: "Write a file",
			parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			execute: async (_toolCallId: string, params: any, _signal?: any, _onUpdate?: any, ctx?: any) => {
				const filePath = String((params as { path?: unknown }).path ?? "");
				const content = String((params as { content?: unknown }).content ?? "");
				executed.push(`write:${filePath}`);
				writeFileSync(join(ctx?.cwd ?? cwdHolder.cwd, filePath), content);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		return [bashTool, editTool, writeTool];
	}

	it("applies edits directly in Auto mode and injects the Auto banner", async () => {
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

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "hello world\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done writing"),
		]);

		await harness.session.prompt("Write hello.txt");

		expect(executed).toEqual(["write:hello.txt"]);
		expect(harness.session.getActiveToolNames().sort()).toEqual(["bash", "edit", "write"]);
		expect(readFileSync(join(harness.tempDir, "hello.txt"), "utf8")).toBe("hello world\n");
		expect(seenPrompts.some((prompt) => prompt.includes("You are in Auto mode"))).toBe(true);
		expect(bannerInMessages(harness, "[AUTO MODE ACTIVE]")).toBe(true);
	});

	it("removes edit and write and blocks bash in Think mode", async () => {
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

		await harness.session.prompt("/mode think");
		expect(harness.session.getActiveToolNames()).toEqual([]);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { path: "fish" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Could not edit"),
		]);

		await harness.session.prompt("Edit the fish file");

		expect(executed).toEqual([]);
		expect(toolResultText(harness)).toContain("Tool edit not found");
		expect(seenPrompts.some((prompt) => prompt.includes("You are in Think mode"))).toBe(true);
		expect(bannerInMessages(harness, "[THINK MODE ACTIVE]")).toBe(true);
	});

	it("stages edits in Confirm mode and applies them after user approval", async () => {
		const cwdHolder = { cwd: "" };
		const executed: string[] = [];
		let approvalRequested = false;

		const harness = await createHarness({
			tools: createRecordingTools(cwdHolder, executed),
			extensionFactories: [permissionModesExtension],
		});
		harnesses.push(harness);
		cwdHolder.cwd = harness.tempDir;

		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: {
				notify: () => {},
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWorkingVisible: () => {},
				setWorkingIndicator: () => {},
				setHiddenThinkingLabel: () => {},
				setWidget: () => {},
				setFooter: () => {},
				setHeader: () => {},
				setTitle: () => {},
				custom: (async (factory: any) => {
					approvalRequested = true;
					let approved = false;
					const fakeTui = {
						terminal: { rows: 24, columns: 80 },
						requestRender: () => {},
					} as any;
					const fakeTheme = {
						fg: (_k: string, t: string) => t,
						bg: (_k: string, t: string) => t,
						bold: (t: string) => t,
					} as any;
					const fakeKeybindings = { matches: () => false } as any;
					const done = (res: boolean) => {
						approved = res;
					};
					await (factory as any)(fakeTui, fakeTheme, fakeKeybindings, done);
					done(true);
					// Simulate choosing Approve Result
					return approved;
				}) as any,
				pasteToEditor: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
				editor: async () => undefined,
				addAutocompleteProvider: () => {},
				setEditorComponent: () => {},
				getEditorComponent: () => undefined,
				theme: {} as any,
				getAllThemes: () => [],
				getTheme: () => undefined,
				setTheme: () => ({ success: true }),
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
				select: async () => undefined,
				confirm: async () => false,
				input: async () => undefined,
				onTerminalInput: () => () => {},
			},
		});

		await harness.session.prompt("/mode confirm");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("write", { path: "sample.txt", content: "staged content\n" }),
					fauxToolCall("bash", { command: "touch extra.txt" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("I created the files"),
		]);

		await harness.session.prompt("Create sample.txt and extra.txt");
		expect(bannerInMessages(harness, "[CONFIRM MODE ACTIVE]")).toBe(true);

		expect(approvalRequested).toBe(true);
		expect(readFileSync(join(harness.tempDir, "sample.txt"), "utf8")).toBe("staged content\n");
		expect(readFileSync(join(harness.tempDir, "extra.txt"), "utf8")).toBe("created\n");
	});

	it("discards staged edits in Confirm mode when user denies the result", async () => {
		const cwdHolder = { cwd: "" };
		const executed: string[] = [];

		const harness = await createHarness({
			tools: createRecordingTools(cwdHolder, executed),
			extensionFactories: [permissionModesExtension],
		});
		harnesses.push(harness);
		cwdHolder.cwd = harness.tempDir;

		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: {
				notify: () => {},
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWorkingVisible: () => {},
				setWorkingIndicator: () => {},
				setHiddenThinkingLabel: () => {},
				setWidget: () => {},
				setFooter: () => {},
				setHeader: () => {},
				setTitle: () => {},
				custom: (async () => false) as any,
				pasteToEditor: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
				editor: async () => undefined,
				addAutocompleteProvider: () => {},
				setEditorComponent: () => {},
				getEditorComponent: () => undefined,
				theme: {} as any,
				getAllThemes: () => [],
				getTheme: () => undefined,
				setTheme: () => ({ success: true }),
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
				select: async () => undefined,
				confirm: async () => false,
				input: async () => undefined,
				onTerminalInput: () => () => {},
			},
		});

		await harness.session.prompt("/mode confirm");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "denied.txt", content: "should not exist\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("I created denied.txt"),
		]);

		await harness.session.prompt("Create denied.txt");

		expect(existsSync(join(harness.tempDir, "denied.txt"))).toBe(false);
	});

	it("blocks mutations before grant in Debug mode, then stages fixes and applies on approval", async () => {
		const cwdHolder = { cwd: "" };
		const executed: string[] = [];
		const seenPrompts: string[] = [];
		let approvalGiven = false;

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

		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: {
				notify: () => {},
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWorkingVisible: () => {},
				setWorkingIndicator: () => {},
				setHiddenThinkingLabel: () => {},
				setWidget: () => {},
				setFooter: () => {},
				setHeader: () => {},
				setTitle: () => {},
				custom: (async () => {
					approvalGiven = true;
					return true;
				}) as any,
				pasteToEditor: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
				editor: async () => undefined,
				addAutocompleteProvider: () => {},
				setEditorComponent: () => {},
				getEditorComponent: () => undefined,
				theme: {} as any,
				getAllThemes: () => [],
				getTheme: () => undefined,
				setTheme: () => ({ success: true }),
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
				select: async () => undefined,
				confirm: async () => false,
				input: async () => undefined,
				onTerminalInput: () => () => {},
			},
		});

		await harness.session.prompt("/mode debug");
		expect(harness.session.getActiveToolNames().sort()).toEqual(["DebugModeImplementingPermissions", "bash"]);

		// Turn 1: Attempt to mutate before permission grant -> blocked
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "touch blocked.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Mutation was blocked, here is the diagnosis and proposed fix."),
		]);
		await harness.session.prompt("Fix the issue");
		expect(bannerInMessages(harness, "[DEBUG MODE ACTIVE]")).toBe(true);

		expect(existsSync(join(harness.tempDir, "blocked.txt"))).toBe(false);
		expect(toolResultText(harness)).toContain("Debug mode: bash is restricted");

		// Turn 2: User approves diagnosis, agent calls DebugModeImplementingPermissions then applies fix in isolated workspace
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("DebugModeImplementingPermissions", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "fixed.txt", content: "bug fixed\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Fix applied, awaiting final approval"),
		]);

		await harness.session.prompt("The fix is approved. Go ahead.");

		expect(approvalGiven).toBe(true);
		expect(readFileSync(join(harness.tempDir, "fixed.txt"), "utf8")).toBe("bug fixed\n");
	});

	it("preserves user messages containing mode markers across mode switches", async () => {
		const harness = await createHarness({
			extensionFactories: [permissionModesExtension],
		});
		harnesses.push(harness);

		await harness.session.prompt("/mode think");
		harness.setResponses([fauxAssistantMessage("thinking done")]);
		await harness.session.prompt("Analyze this while in [THINK MODE ACTIVE]");

		await harness.session.prompt("/mode auto");
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
			if (typeof content === "string") return content.includes("Analyze this while in [THINK MODE ACTIVE]");
			if (Array.isArray(content)) {
				return content.some(
					(c) =>
						typeof c === "object" &&
						c !== null &&
						"text" in c &&
						(c as { text: string }).text.includes("Analyze this while in [THINK MODE ACTIVE]"),
				);
			}
			return false;
		});
		expect(hasOriginalPrompt).toBe(true);
	});
});
