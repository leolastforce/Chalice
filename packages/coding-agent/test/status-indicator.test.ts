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

	it("shows only the pulsing dot, in both display modes", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const indicator = new WorkingStatusIndicator(createTui(), "Working");
		try {
			for (const frame of ["·", "·", "•", "•", "●", "●", "•", "•", "·"]) {
				expect(stripAnsi(indicator.renderInline(40))).toBe(frame);
				expect(stripAnsi(indicator.render(40)[1]!).trim()).toBe(frame);
				expect(indicator.renderInline(40)).toContain(theme.getFgAnsi("accent"));
				expect(visibleWidth(indicator.renderInline(40))).toBe(1);
				vi.advanceTimersByTime(80);
			}
			indicator.setMessage("Custom message");
			expect(stripAnsi(indicator.renderInline(40))).not.toContain("Custom message");
		} finally {
			indicator.dispose();
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps custom spinner overrides and restores the dot spinner", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const indicator = new WorkingStatusIndicator(createTui(), "Working");
		try {
			indicator.setIndicator({ frames: ["A", "B"], intervalMs: 100 });
			expect(stripAnsi(indicator.renderInline(40))).toBe("A");
			vi.advanceTimersByTime(100);
			expect(stripAnsi(indicator.renderInline(40))).toBe("B");
			indicator.setIndicator({ frames: [] });
			expect(stripAnsi(indicator.renderInline(40))).toBe("");
			indicator.setIndicator();
			expect(stripAnsi(indicator.renderInline(40))).toBe("·");
		} finally {
			indicator.dispose();
		}
	});

	it("renders only the spinner inline before the input prompt when the editor opts in", () => {
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
		expect(firstLine).toContain("● >");
		expect(firstLine).not.toContain("Working");
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
