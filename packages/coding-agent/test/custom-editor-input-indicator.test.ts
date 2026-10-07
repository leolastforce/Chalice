import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomEditor input indicator", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	afterEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("uses default indicator >", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		expect(editor.getInputIndicator()).toBe(">");

		editor.setText("hello");
		const lines = editor.render(80);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("> hello");
	});

	it("supports custom indicator", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings, {
			inputIndicator: "❯",
		});
		expect(editor.getInputIndicator()).toBe("❯");

		editor.setText("test message");
		const lines = editor.render(80);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("❯ test message");
	});

	it("supports empty string as indicator", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings, {
			inputIndicator: "",
		});
		expect(editor.getInputIndicator()).toBe("");

		editor.setText("no indicator");
		const lines = editor.render(80);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("no indicator");
		expect(rendered).not.toContain("> no indicator");
	});

	it("updates indicator dynamically via setInputIndicator", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		expect(editor.getInputIndicator()).toBe(">");

		editor.setText("dynamic");
		let lines = editor.render(80);
		expect(stripAnsi(lines.join("\n"))).toContain("> dynamic");

		editor.setInputIndicator("$");
		expect(editor.getInputIndicator()).toBe("$");
		lines = editor.render(80);
		expect(stripAnsi(lines.join("\n"))).toContain("$ dynamic");

		editor.setInputIndicator("");
		expect(editor.getInputIndicator()).toBe("");
		lines = editor.render(80);
		expect(stripAnsi(lines.join("\n"))).toContain("dynamic");
		expect(stripAnsi(lines.join("\n"))).not.toContain("$ dynamic");
	});

	it("renders spinner working status alongside custom and empty indicators", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const tui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(tui, defaultEditorTheme, keybindings, {
			inputIndicator: "❯",
		});
		const indicator = new WorkingStatusIndicator(tui, "Processing...");
		editor.setWorkingStatusIndicator(indicator);

		editor.setText("input");
		let lines = editor.render(80);
		let rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("❯ input");

		editor.setInputIndicator("");
		lines = editor.render(80);
		rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("input");
		indicator.dispose();
	});
});
