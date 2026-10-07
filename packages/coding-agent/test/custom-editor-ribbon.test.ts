import { setKeybindings, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createEditor(options?: { ribbonLocation?: "top" | "bottom"; ribbonBorder?: boolean }): CustomEditor {
	setKeybindings(new KeybindingsManager());
	const editor = new CustomEditor(
		new TuiMainScreen(new VirtualTerminal()),
		defaultEditorTheme,
		new KeybindingsManager(),
		{
			ribbon: () => "STATS",
			ribbonLocation: options?.ribbonLocation,
			ribbonBorder: options?.ribbonBorder,
		},
	);
	editor.setText("hello");
	return editor;
}

const RIBBON_ROW = (lines: string[]): number => lines.findIndex((line) => line.includes("STATS"));
const BORDER_ROW = (lines: string[]): number => lines.findIndex((line) => /─{5,}/.test(line));

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor ribbon placement", () => {
	it("defaults to the ribbon below the input and no border", () => {
		const lines = createEditor().render(40);
		const ribbonRow = RIBBON_ROW(lines);
		const inputRow = lines.findIndex((line) => line.includes("hello"));
		expect(ribbonRow).toBeGreaterThan(inputRow);
		expect(BORDER_ROW(lines)).toBe(-1);
	});

	it("renders the ribbon above the input when location is top", () => {
		const lines = createEditor({ ribbonLocation: "top" }).render(40);
		const ribbonRow = RIBBON_ROW(lines);
		const inputRow = lines.findIndex((line) => line.includes("hello"));
		expect(ribbonRow).toBeLessThan(inputRow);
	});

	it("renders the border on the opposite side of the ribbon", () => {
		const topLines = createEditor({ ribbonLocation: "top", ribbonBorder: true }).render(40);
		expect(RIBBON_ROW(topLines)).toBeLessThan(BORDER_ROW(topLines));

		const bottomLines = createEditor({ ribbonLocation: "bottom", ribbonBorder: true }).render(40);
		expect(RIBBON_ROW(bottomLines)).toBeGreaterThan(BORDER_ROW(bottomLines));
	});

	it("renders the dynamic border at the full editor width", () => {
		const lines = createEditor({ ribbonLocation: "top", ribbonBorder: true }).render(40);
		const borderLine = lines.find((line) => /─{5,}/.test(line));
		expect(borderLine).toBeDefined();
		expect(visibleWidth(borderLine ?? "")).toBe(40);
		expect(borderLine).toContain("╰");
	});
});
