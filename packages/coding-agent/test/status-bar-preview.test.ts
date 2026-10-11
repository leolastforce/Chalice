import { beforeAll, describe, expect, it } from "vitest";
import { renderStatusBar } from "../src/modes/interactive/components/status-bar-layout.ts";
import {
	createSampleStatusBarSegments,
	StatusBarPreviewComponent,
} from "../src/modes/interactive/components/status-bar-preview.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("StatusBarPreviewComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders preview with default top location and without border", () => {
		const preview = new StatusBarPreviewComponent({
			ribbon: { style: "powerline", location: "top", layout: "middle", border: false },
			inputIndicator: ">",
			sampleText: "Type a message...",
		});

		const lines = preview.render(80).map((l) => stripAnsi(l));
		expect(lines[0]).toContain("Preview:");
		// In top location: status bar line is above input line
		expect(lines[1]).toContain("default");
		expect(lines[2]).toContain("> Type a message...");
		expect(lines.some((l) => l.includes("╰") || l.includes("╭"))).toBe(false);
	});

	it("renders preview with top location and border", () => {
		const preview = new StatusBarPreviewComponent({
			ribbon: { style: "powerline", location: "top", layout: "middle", border: true },
			inputIndicator: "$",
		});

		const lines = preview.render(80).map((l) => stripAnsi(l));
		expect(lines[0]).toContain("Preview:");
		expect(lines[1]).toContain("default");
		expect(lines[2]).toContain("$ Type a message...");
		// Top location border sits below the input box using bottom corner ╰
		expect(lines[3]).toContain("╰");
	});

	it("renders preview with bottom location and border", () => {
		const preview = new StatusBarPreviewComponent({
			ribbon: { style: "powerline", location: "bottom", layout: "middle", border: true },
			inputIndicator: "➜",
		});

		const lines = preview.render(80).map((l) => stripAnsi(l));
		expect(lines[0]).toContain("Preview:");
		// Bottom location border sits above the input box using top corner ╭
		expect(lines[1]).toContain("╭");
		expect(lines[2]).toContain("➜ Type a message...");
		expect(lines[3]).toContain("default");
	});

	it("updates when ribbon and inputIndicator change", () => {
		const preview = new StatusBarPreviewComponent({
			ribbon: { style: "minimal", location: "bottom" },
			inputIndicator: ">",
		});

		let lines = preview.render(80).map((l) => stripAnsi(l));
		expect(lines.some((l) => l.includes("[default]"))).toBe(true);
		expect(lines.some((l) => l.includes("> Type a message..."))).toBe(true);

		preview.setInputIndicator("pi >");
		preview.setRibbon({ style: "rounded", location: "top" });

		lines = preview.render(80).map((l) => stripAnsi(l));
		expect(lines[1]).toContain("default");
		expect(lines[2]).toContain("pi > Type a message...");
	});

	it("respects minimal style rendering", () => {
		const preview = new StatusBarPreviewComponent({
			ribbon: { style: "minimal", location: "top" },
		});

		const output = stripAnsi(preview.render(80).join("\n"));
		expect(output).toContain("[default]");
		expect(output).toContain("[chalice]");
	});

	it("respects disabled stats in ribbon configuration", () => {
		const { segments } = createSampleStatusBarSegments({
			mode: false,
			cost: false,
			directory: true,
		});

		const labels = segments.map(([label]) => label);
		expect(labels).not.toContain("default");
		expect(labels).not.toContain("$0.00");
		expect(labels).toContain("chalice");
	});

	it("truncates lines to specified width", () => {
		const preview = new StatusBarPreviewComponent({
			ribbon: { style: "powerline" },
			inputIndicator: ">",
		});

		const lines = preview.render(30);
		for (const line of lines) {
			expect(stripAnsi(line).length).toBeLessThanOrEqual(30);
		}
	});
});

describe("renderStatusBar", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders left, middle, and right layouts correctly", () => {
		const { segments, pinnedSegment } = createSampleStatusBarSegments();

		const leftResult = stripAnsi(renderStatusBar(segments, { layout: "left", style: "minimal" }, 100));
		const rightResult = stripAnsi(renderStatusBar(segments, { layout: "right", style: "minimal" }, 100));
		const middleResult = stripAnsi(
			renderStatusBar(segments, { layout: "middle", style: "minimal", pinnedSegment }, 100),
		);

		expect(leftResult).toContain("[default]");
		expect(rightResult).toContain("[default]");
		expect(middleResult).toContain("[default]");
		// Middle layout uses filler ─
		expect(middleResult).toContain("─");
	});
});
