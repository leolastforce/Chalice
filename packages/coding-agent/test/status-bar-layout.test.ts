import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	composeStatusBarLine,
	placeStatusBarStats,
	renderPowerlineGroup,
	renderStatusBar,
} from "../src/modes/interactive/components/status-bar-layout.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status bar layout", () => {
	it("keeps all stats on the left or right for those layouts", () => {
		const stats = ["a", "b", "c"];
		expect(placeStatusBarStats(stats, "left")).toEqual({ left: stats, right: [] });
		expect(placeStatusBarStats(stats, "right")).toEqual({ left: [], right: stats });
	});

	it("centers the median stat and alternates the rest between sides", () => {
		expect(placeStatusBarStats(["a", "b", "c", "d", "e"], "middle")).toEqual({
			left: ["a", "d"],
			center: "c",
			right: ["b", "e"],
		});
	});

	it("pins the model stat in the center instead of the median", () => {
		expect(placeStatusBarStats(["a", "model", "b", "c"], "middle", "model")).toEqual({
			left: ["a", "c"],
			center: "model",
			right: ["b"],
		});
	});

	it("centers the middle stat and aligns the right group to the right edge", () => {
		const line = composeStatusBarLine({ left: "L", center: "M", right: "R" }, 20);
		expect(visibleWidth(line)).toBe(20);
		expect(line.indexOf("M")).toBe(9);
		expect(line.indexOf("R")).toBe(19);
	});
	it("adds both powerline caps to the centered segment", () => {
		const rendered = renderPowerlineGroup(["model"], "BG", "FG", "SEP", "center");
		expect(rendered).toBe("FG\x1b[49mBG model FG\x1b[49m");
	});

	it("mirrors powerline segments and separators on the right", () => {
		const rendered = renderPowerlineGroup(["cost", "context"], "BG", "FG", "SEP", "right");
		expect(rendered).toBe("FG\x1b[49mBG cost BGSEP context \x1b[49m");
	});

	it("keeps the left powerline direction unchanged", () => {
		const rendered = renderPowerlineGroup(["mode", "directory"], "BG", "FG", "SEP", "left");
		expect(rendered).toBe("BG mode BGSEP directory FG\x1b[49m");
	});

	it("connects all stats together with a line when filler is provided", () => {
		const line = composeStatusBarLine({ left: "L", center: "M", right: "R" }, 20, "─");
		expect(visibleWidth(line)).toBe(20);
		expect(line).toBe("L────────M─────────R");
	});

	it("does not draw connecting lines when left or right stats are absent", () => {
		const noLeft = composeStatusBarLine({ left: "", center: "M", right: "R" }, 20, "─");
		expect(visibleWidth(noLeft)).toBe(20);
		expect(noLeft).toBe("         M─────────R");

		const noRight = composeStatusBarLine({ left: "L", center: "M", right: "" }, 20, "─");
		expect(visibleWidth(noRight)).toBe(20);
		expect(noRight).toBe("L────────M          ");
	});

	it("connects left and right directly when center is undefined", () => {
		const line = composeStatusBarLine({ left: "L", right: "R" }, 20, "─");
		expect(visibleWidth(line)).toBe(20);
		expect(line).toBe("L──────────────────R");
	});

	it("twinkles stars across connectors without changing labels or width", () => {
		initTheme("dark");
		const parts = { left: "L", center: "M", right: "R" };
		const idle = composeStatusBarLine(parts, 20, "─");
		const first = composeStatusBarLine(parts, 20, "─", 1);
		const second = composeStatusBarLine(parts, 20, "─", 2);
		expect(first).not.toBe(second);
		expect(first).not.toBe(idle);
		expect(stripAnsi(first)).toMatch(/[·✦✧✶✳*⋆]/);
		expect(stripAnsi(first).replace(/[·✦✧✶✳*⋆]/g, "─")).toBe(idle);
		expect(stripAnsi(second).replace(/[·✦✧✶✳*⋆]/g, "─")).toBe(idle);
		expect(composeStatusBarLine(parts, 20, "─", 1)).toBe(first);
		expect(visibleWidth(first)).toBe(20);
	});

	it("brightens only the sparkle and restores the connector foreground", () => {
		const line = composeStatusBarLine({ left: "\x1b[38;2;20;40;60mL", right: "R" }, 30, "─", 1);
		expect(line).toMatch(/\x1b\[38;2;138;148;158m[·✦✧✶✳*⋆]\x1b\[38;2;20;40;60m─/);
	});

	it("uses multiple sparkle shapes over time", () => {
		const frames = Array.from({ length: 114 }, (_, frame) =>
			stripAnsi(composeStatusBarLine({ left: "L", right: "R" }, 50, "─", frame)),
		).join("");
		for (const star of ["✦", "✧", "✶", "✳", "*", "⋆"]) expect(frames).toContain(star);
	});

	it("leaves unconnected and overflowing layouts safe", () => {
		initTheme("dark");
		expect(composeStatusBarLine({ left: "", right: "R" }, 8, "─", 2)).toBe(
			composeStatusBarLine({ left: "", right: "R" }, 8, "─"),
		);
		for (const width of [0, 1, 3, 8]) {
			const line = composeStatusBarLine({ left: "LONG", center: "中", right: "RIGHT" }, width, "─", 2);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("preserves visible output across styles, layouts and terminal widths", () => {
		initTheme("dark");
		const segments = [
			["a", "A", "accent"],
			["b", "B", "text"],
			["c", "C", "warning"],
		] as const;
		for (const style of ["minimal", "rounded", "powerline"] as const) {
			for (const layout of ["left", "middle", "right"] as const) {
				for (const width of [4, 20, 80]) {
					const idle = renderStatusBar(
						segments.map((segment) => [...segment]),
						{ style, layout },
						width,
					);
					const active = renderStatusBar(
						segments.map((segment) => [...segment]),
						{ style, layout, animationFrame: 9 },
						width,
					);
					expect(stripAnsi(active).replace(/[·✦✧✶✳*⋆]/g, "─")).toBe(stripAnsi(idle));
					expect(visibleWidth(active)).toBeLessThanOrEqual(width);
				}
			}
		}
	});
});
