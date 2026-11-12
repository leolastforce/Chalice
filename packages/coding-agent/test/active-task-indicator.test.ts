import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityIndicator } from "../../../Chalice/ActiveTask/indicator.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("activity indicator", () => {
	afterEach(() => vi.useRealTimers());

	it("cycles the twenty copied symbol sequences on both sides", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const indicator = new ActivityIndicator({ requestRender: vi.fn() } as unknown as TUI, theme, "Reading code");
		try {
			for (const symbol of [
				"·",
				"⠁",
				"·",
				"○",
				"·",
				"⠋",
				"⠁",
				"⠈",
				"◴",
				"◐",
				"◰",
				"◇",
				"▪",
				"▏",
				"▁",
				"⠁",
				"╱",
				"+",
				"⋄",
				"▖",
				"·",
			]) {
				expect(indicator.render(80).map(stripAnsi)).toEqual([`${symbol} Reading code ${symbol}`]);
				vi.advanceTimersByTime(3200);
			}
		} finally {
			indicator.dispose();
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("sweeps the accent wave and stops both timers on disposal", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const indicator = new ActivityIndicator({ requestRender } as unknown as TUI, theme, "Reading code");
		try {
			const first = indicator.render(80)[0]!;
			expect(stripAnsi(first)).toBe("· Reading code ·");
			expect(first).toContain(theme.getFgAnsi("accent"));
			expect(first).toContain(theme.getFgAnsi("muted"));
			expect(first).toContain("\x1b[4mR\x1b[24m");
			vi.advanceTimersByTime(120);
			const second = indicator.render(80)[0]!;
			expect(second).toContain("\x1b[4me\x1b[24m");
			expect(visibleWidth(second)).toBe(visibleWidth(first));
		} finally {
			indicator.dispose();
		}
		expect(vi.getTimerCount()).toBe(0);
		const calls = requestRender.mock.calls.length;
		vi.advanceTimersByTime(1000);
		expect(requestRender).toHaveBeenCalledTimes(calls);
	});

	it("fits narrow terminals and reserves the right symbol", () => {
		initTheme("dark");
		const indicator = new ActivityIndicator(
			{ requestRender: vi.fn() } as unknown as TUI,
			theme,
			"Investigating 日本語 session restoration",
		);
		try {
			for (const width of [0, 1, 2, 3, 4, 5, 8, 18, 80]) {
				const lines = indicator.render(width);
				expect(lines).toHaveLength(1);
				expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
				if (width >= 4) expect(stripAnsi(lines[0]!)).toMatch(/^· .* ·$/u);
			}
		} finally {
			indicator.dispose();
		}
	});
});
