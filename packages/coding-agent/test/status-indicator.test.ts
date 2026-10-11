import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createTui(): TUI {
	return { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
}

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as standalone status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("renders no status row while no working indicator is set", () => {
		initTheme("dark");
		const editor = new CustomEditor(createTui(), getEditorTheme(), KeybindingsManager.create());

		expect(editor.embedWorkingStatus).toBe(false);
		expect(editor.render(20).map(stripAnsi)).toEqual([`> ${" ".repeat(18)}`]);
	});

	it("styles the standalone working indicator with accent and muted colors", () => {
		initTheme("dark");
		const tui = createTui();
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);

		const standaloneLine = indicator.render(20)[1]!;
		expect(standaloneLine).toContain(theme.getFgAnsi("accent"));
		expect(standaloneLine).toContain(theme.getFgAnsi("muted"));
		indicator.dispose();
	});

	it("sweeps an accent wave across the muted working text without changing its width", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = createTui();
		const indicator = new WorkingStatusIndicator(tui, "Working", { frames: ["●"] });

		try {
			const firstFrame = indicator.render(30)[1]!;
			expect(stripAnsi(firstFrame)).toContain("Working");
			expect(firstFrame).toContain(theme.getFgAnsi("accent"));
			expect(firstFrame).toContain(theme.getFgAnsi("muted"));
			expect(firstFrame).toContain("\x1b[4m");
			const width = visibleWidth(firstFrame);

			vi.advanceTimersByTime(120);
			const secondFrame = indicator.render(30)[1]!;
			expect(stripAnsi(secondFrame)).toContain("Working");
			expect(visibleWidth(secondFrame)).toBe(width);
			expect(secondFrame).not.toBe(firstFrame);
		} finally {
			indicator.dispose();
		}
	});

	it("renders the working text inline before the input prompt when the editor opts in", () => {
		initTheme("dark");
		const tui = createTui();
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		expect(editor.embedWorkingStatus).toBe(true);
		editor.borderColor = theme.getThinkingBorderColor("high");
		const indicator = new WorkingStatusIndicator(tui, "Working", { frames: ["●"] }, (text) =>
			editor.borderColor(text),
		);
		editor.setWorkingStatusIndicator(indicator);

		const lines = editor.render(20);
		const firstLine = stripAnsi(lines[0]!);
		expect(firstLine).toContain("Working ● >");
		expect(lines).toHaveLength(1);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(20);
		}
		indicator.dispose();
	});

	it("renders compaction, summary, and retry labels within the editor width", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = createTui();
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		const indicators = [
			new CompactionStatusIndicator(tui, "manual"),
			new CompactionStatusIndicator(tui, "threshold"),
			new CompactionStatusIndicator(tui, "overflow"),
			new BranchSummaryStatusIndicator(tui),
			new RetryStatusIndicator(tui, 1, 3, 3000),
		];
		try {
			for (const indicator of indicators) {
				editor.setWorkingStatusIndicator(indicator);
				const label = stripAnsi(indicator.render(120)[1]!)
					.trim()
					.replace(/^\S+\s+/, "");
				expect(stripAnsi(editor.render(120)[0]!)).toContain(label);
				for (const width of [4, 10, 20, 80, 120]) {
					for (const line of editor.render(width)) {
						expect(visibleWidth(line)).toBe(width);
					}
				}
			}
			vi.advanceTimersByTime(1000);
			expect(stripAnsi(editor.render(120)[0]!)).toContain("Retrying (1/3) in 2s");
			editor.setWorkingStatusIndicator(undefined);
			expect(editor.render(120)).toHaveLength(1);
		} finally {
			for (const indicator of indicators) indicator.dispose();
		}
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});
