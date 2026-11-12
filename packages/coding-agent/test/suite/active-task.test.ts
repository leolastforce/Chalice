import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import activeTaskExtension from "../../../../Chalice/ActiveTask/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

describe("Current activity", () => {
	const harnesses: Harness[] = [];
	const widgets = new Set<Component & { dispose?(): void }>();

	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		for (const widget of widgets) widget.dispose?.();
		widgets.clear();
	});

	async function setup() {
		let widget: (Component & { dispose?(): void }) | undefined;
		const harness = await createHarness({ tools: [], extensionFactories: [activeTaskExtension] });
		harnesses.push(harness);
		const uiContext = createTestUiContext({
			setWidget(key, content, options) {
				expect(key).toBe("active-task");
				widget?.dispose?.();
				if (typeof content === "function") {
					expect(options).toEqual({ placement: "aboveEditor" });
					widget = content({ requestRender: vi.fn() } as unknown as TUI, theme);
					widgets.add(widget);
				} else {
					expect(content).toBeUndefined();
					widget = undefined;
				}
			},
		});
		await harness.session.bindExtensions({ uiContext, mode: "tui" });
		return { harness, uiContext, render: (width = 80) => widget?.render(width).map(stripAnsi) };
	}

	async function setActivity(harness: Harness, text: string) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("active_task", { text }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Continue working");
	}

	it("replaces one line, retains it across turns, and explicitly clears it", async () => {
		const { harness, render } = await setup();
		expect(render()).toBeUndefined();
		await setActivity(harness, "Investigating session restoration");
		expect(render()).toEqual(["· Investigating session restoration ·"]);
		const firstState = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom" && entry.customType === "active-task");

		await setActivity(harness, "Verifying the fix");
		expect(render()).toEqual(["· Verifying the fix ·"]);
		expect(firstState).toMatchObject({ data: "Investigating session restoration" });
		harness.setResponses([fauxAssistantMessage("Another answer")]);
		await harness.session.prompt("Quick question");
		expect(render()).toEqual(["· Verifying the fix ·"]);

		await setActivity(harness, "");
		expect(render()).toBeUndefined();
		expect(getToolResult(harness, "active_task").details).toEqual({ text: "" });
	});

	it("normalizes whitespace and truncates to one terminal-width-aware line", async () => {
		const { harness, render } = await setup();
		await setActivity(harness, "  Investigating\n\t日本語 session restoration  ");
		expect(getToolResult(harness, "active_task").details).toEqual({
			text: "Investigating 日本語 session restoration",
		});
		for (const width of [1, 8, 18, 80]) {
			const lines = render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines?.[0] ?? "")).toBeLessThanOrEqual(width);
		}
		await setActivity(harness, " \n\t ");
		expect(render()).toBeUndefined();
	});

	it("restores the selected branch and persisted clears on session start", async () => {
		const { harness, uiContext, render } = await setup();
		await setActivity(harness, "Investigating");
		const firstLeaf = harness.sessionManager.getLeafId();
		expect(firstLeaf).not.toBeNull();
		await setActivity(harness, "Verifying");
		const secondLeaf = harness.sessionManager.getLeafId();
		expect(secondLeaf).not.toBeNull();
		await setActivity(harness, "");
		const clearedLeaf = harness.sessionManager.getLeafId();
		expect(clearedLeaf).not.toBeNull();

		await harness.session.navigateTree(firstLeaf!, { summarize: false });
		expect(render()).toEqual(["· Investigating ·"]);
		await harness.session.navigateTree(secondLeaf!, { summarize: false });
		expect(render()).toEqual(["· Verifying ·"]);

		// A fresh extension runtime must restore the snapshot, not its previous in-memory value.
		await harness.session.reload();
		expect(render()).toEqual(["· Verifying ·"]);
		await harness.session.navigateTree(clearedLeaf!, { summarize: false });
		expect(render()).toBeUndefined();
		await harness.session.bindExtensions({ uiContext, mode: "tui" });
		expect(render()).toBeUndefined();
	});

	it("works without UI and does not migrate legacy checklists", async () => {
		const harness = await createHarness({ tools: [], extensionFactories: [activeTaskExtension] });
		harnesses.push(harness);
		harness.sessionManager.appendCustomEntry("todo-state", {
			todos: [{ id: 1, text: "Old", done: false }],
			nextId: 2,
		});
		await harness.session.bindExtensions({});
		await setActivity(harness, "Reading code");
		expect(getToolResult(harness, "active_task").details).toEqual({ text: "Reading code" });
		expect(harness.sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "active-task",
				data: "Reading code",
			}),
		);
	});

	it("includes activity guidance only while the tool is active, without TODO instructions", async () => {
		const prompts: string[] = [];
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				activeTaskExtension,
				(pi) => {
					pi.on("before_agent_start", (event) => {
						prompts.push(event.systemPrompt);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
		harness.session.setActiveToolsByName([]);
		await harness.session.prompt("Quick answer");
		harness.session.setActiveToolsByName(["active_task"]);
		await harness.session.prompt("Investigate");
		expect(prompts[0]).not.toContain("Use active_task");
		expect(prompts[1]).toContain("Use active_task when starting meaningful work");
		expect(prompts[1]).toContain("replace it when your focus changes");
		expect(prompts[1]).toContain("Skip updates for trivial answers");
		expect(prompts[1]).not.toContain("Use todo proactively");
		expect(prompts[1]).not.toContain("user-visible TODO list");
	});
});
