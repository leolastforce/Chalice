import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { composeStatusBarLine, placeStatusBarStats } from "../src/modes/interactive/components/status-bar-layout.ts";

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
});
