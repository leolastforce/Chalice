import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	composeStatusBarLine,
	placeStatusBarStats,
	renderPowerlineGroup,
} from "../src/modes/interactive/components/status-bar-layout.ts";

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
});
