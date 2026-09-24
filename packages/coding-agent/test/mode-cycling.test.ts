import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { CHALICE_MODES, type ChaliceMode } from "../src/modes/interactive/components/footer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const TAB = "\t";

function createEditor(): { editor: CustomEditor; cycles: () => number } {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
	let cycled = 0;
	editor.onAction("app.mode.cycle", () => {
		cycled++;
	});
	return { editor, cycles: () => cycled };
}

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("Tab mode cycling", () => {
	it("defaults app.mode.cycle to Tab", () => {
		expect(new KeybindingsManager().getKeys("app.mode.cycle")).toEqual(["tab"]);
	});

	it("cycles while autocomplete is closed and defers to it while open", () => {
		const { editor, cycles } = createEditor();

		editor.handleInput(TAB);
		expect(cycles()).toBe(1);

		vi.spyOn(editor, "isShowingAutocomplete").mockReturnValue(true);
		editor.handleInput(TAB);
		expect(cycles()).toBe(1);
	});

	it("stops cycling when app.mode.cycle is unbound", () => {
		const keybindings = new KeybindingsManager({ "app.mode.cycle": [] });
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let cycled = 0;
		editor.onAction("app.mode.cycle", () => {
			cycled++;
		});

		editor.handleInput(TAB);
		expect(cycled).toBe(0);
	});
});

describe("InteractiveMode mode cycling", () => {
	beforeEach(() => initTheme("dark"));

	function createModeHost() {
		const footer = { setMode: vi.fn() };
		const host = {
			chaliceMode: "Change" as ChaliceMode,
			footer,
			chaliceBaseTools: undefined as string[] | undefined,
			session: {
				getActiveToolNames: () => ["bash", "edit", "write"],
				setActiveToolsByName: vi.fn(),
				extensionRunner: { events: { emit: vi.fn() } },
			},
			showStatus: vi.fn(),
		};
		const cycleMode = Reflect.get(InteractiveMode.prototype, "cycleMode") as (this: typeof host) => void;
		return { host, cycleMode, footer };
	}

	it("advances through every mode in order and wraps back to Change", () => {
		const { host, cycleMode, footer } = createModeHost();
		const seen: ChaliceMode[] = [];

		for (let index = 0; index < CHALICE_MODES.length; index++) {
			cycleMode.call(host);
			seen.push(host.chaliceMode);
			expect(footer.setMode).toHaveBeenLastCalledWith(host.chaliceMode);
		}

		expect(seen).toEqual(["Think", "Review", "Debug", "Change"]);
	});
});
