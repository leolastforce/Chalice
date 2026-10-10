import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DEFAULT_RIBBON_SETTINGS, type RibbonSettings } from "../src/core/settings-manager.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("SettingsSelectorComponent", () => {
	let harness: Harness | undefined;
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("renders safely when persisted enum settings are invalid", () => {
		const config = {
			ribbon: { style: "invalid", location: "invalid", layout: "invalid" },
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			availableThemes: [],
			defaultProjectTrust: "invalid",
			warnings: {},
		} as unknown as SettingsConfig;

		const list = new SettingsSelectorComponent(config, {} as SettingsCallbacks).getSettingsList();
		expect(() => list.render(120)).not.toThrow();
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const onHeaderBannerChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			headerBanner: "full",
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
			onHeaderBannerChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
		cycle("Welcome/Header banner type", 3);
		expect(onHeaderBannerChange.mock.calls.flat()).toEqual(["compact", "none", "full"]);
	});

	it("toggles the username setting", () => {
		const onUsernameEnabledChange = vi.fn();
		const config = {
			usernameEnabled: true,
			username: "Leona",
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
			currentTheme: "dark",
			steeringMode: "all",
			followUpMode: "all",
			transport: "auto",
			httpIdleTimeoutMs: 300000,
			mermaidRenderingMode: "streaming",
			defaultProjectTrust: "ask",
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			tuiMode: "regular",
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
		} as unknown as SettingsConfig;
		const callbacks = { onUsernameEnabledChange } as unknown as SettingsCallbacks;

		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("username");
		list.handleInput("\r");

		expect(onUsernameEnabledChange).toHaveBeenCalledTimes(1);
		expect(onUsernameEnabledChange).toHaveBeenCalledWith(false);
		expect(stripAnsi(list.render(120).join("\n"))).toContain("currently: Leona");
	});

	it("maps the update notification toggle to the disable setting", () => {
		const runToggle = (disableUpdateNotification: boolean) => {
			const onDisableUpdateNotificationChange = vi.fn();
			const config = {
				disableUpdateNotification,
				warnings: {},
				defaultModel: "not set",
				availableDefaultModels: [],
				availableThinkingLevels: [],
				modelThinkingLevels: {},
				availableThemes: [],
			} as unknown as SettingsConfig;
			const callbacks = {
				onDisableUpdateNotificationChange,
			} as unknown as SettingsCallbacks;

			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of "Update notification") list.handleInput(character);
			list.handleInput("\r");

			return onDisableUpdateNotificationChange.mock.calls.flat();
		};

		// Toggling the popup off disables it; toggling it back on re-enables it.
		expect(runToggle(false)).toEqual([true]);
		expect(runToggle(true)).toEqual([false]);
	});

	it("keeps the configured fixed theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("    Automatic");
		expect(output).toContain("→ ✓ dark");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ dark");
		expect(output).toContain("→   light");
	});

	it("keeps a configured automatic theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light", "other"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ light");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ light");
		expect(output).toContain("→   other");
	});

	it("keeps the configured per-model thinking level marked while browsing", async () => {
		harness = await createHarness({
			models: [{ id: "thinking-model", reasoning: true }],
		});
		const model = harness.getModel("thinking-model")!;
		const modelKey = `${model.provider}/${model.id}`;
		const config = {
			defaultModel: modelKey,
			availableDefaultModels: [model],
			thinkingLevel: "high",
			modelThinkingLevels: { [modelKey]: "medium" },
		} as unknown as SettingsConfig;
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("model-thinking");
		list.handleInput("\r");
		list.handleInput("\r");

		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ medium");
		expect(output).toContain("    (clear override)");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ medium");
		expect(output).toContain("→   high");
	});

	it("toggles below input bar stats in its submenu", () => {
		const onRibbonChange = vi.fn();
		const config = {
			ribbon: DEFAULT_RIBBON_SETTINGS,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
			currentTheme: "dark",
			steeringMode: "all",
			followUpMode: "all",
			transport: "auto",
			httpIdleTimeoutMs: 300000,
			mermaidRenderingMode: "streaming",
			defaultProjectTrust: "ask",
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			tuiMode: "regular",
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
		} as unknown as SettingsConfig;
		const callbacks = { onRibbonChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("below-input-stats");
		list.handleInput("\r"); // open the submenu
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("Status bar stats visibility");
		expect(output).toMatch(/→ Mode\s+true/);

		list.handleInput("\r"); // toggle "Mode" off
		expect(onRibbonChange).toHaveBeenCalledTimes(1);
		expect((onRibbonChange.mock.calls[0][0] as RibbonSettings).mode).toBe(false);
		expect(stripAnsi(list.render(120).join("\n"))).toMatch(/→ Mode\s+false/);

		list.handleInput("\r"); // toggle "Mode" back on
		expect(onRibbonChange).toHaveBeenCalledTimes(2);
		expect((onRibbonChange.mock.calls[1][0] as RibbonSettings).mode).toBe(true);

		list.handleInput("\x1b"); // close the submenu; the summary reflects the final state
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("8 of 9 shown"); // everything on except the MCP default (off)
	});

	it("cycles status bar style", () => {
		const onRibbonChange = vi.fn();
		const config = {
			ribbon: { ...DEFAULT_RIBBON_SETTINGS },
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
			currentTheme: "dark",
			steeringMode: "all",
			followUpMode: "all",
			transport: "auto",
			httpIdleTimeoutMs: 300000,
			mermaidRenderingMode: "streaming",
			defaultProjectTrust: "ask",
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			tuiMode: "regular",
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
		} as unknown as SettingsConfig;
		const callbacks = { onRibbonChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("status-bar-style");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Status bar style\s+Rounded/);

		// Cycle to next style (Powerline)
		list.handleInput("\r");
		expect(onRibbonChange).toHaveBeenCalledTimes(1);
		expect((onRibbonChange.mock.calls[0][0] as RibbonSettings).style).toBe("powerline");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Status bar style\s+Powerline/);

		// Cycle to next style (Minimal)
		list.handleInput("\r");
		expect(onRibbonChange).toHaveBeenCalledTimes(2);
		expect((onRibbonChange.mock.calls[1][0] as RibbonSettings).style).toBe("minimal");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Status bar style\s+Minimal/);

		// Cycle back to Rounded
		list.handleInput("\r");
		expect(onRibbonChange).toHaveBeenCalledTimes(3);
		expect((onRibbonChange.mock.calls[2][0] as RibbonSettings).style).toBe("rounded");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Status bar style\s+Rounded/);
	});

	it("cycles status bar layout through left, right, and middle", () => {
		const onRibbonChange = vi.fn();
		const config = {
			ribbon: { ...DEFAULT_RIBBON_SETTINGS },
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
			currentTheme: "dark",
			steeringMode: "all",
			followUpMode: "all",
			transport: "auto",
			httpIdleTimeoutMs: 300000,
			mermaidRenderingMode: "streaming",
			defaultProjectTrust: "ask",
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			tuiMode: "regular",
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
		} as unknown as SettingsConfig;
		const callbacks = { onRibbonChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("status-bar-layout");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Status bar layout\s+Left/);
		let expectedCalls = 0;
		for (const [layout, label] of [
			["right", "Right"],
			["middle", "Middle"],
			["left", "Left"],
		] as const) {
			list.handleInput("\r");
			expectedCalls += 1;
			expect(onRibbonChange).toHaveBeenCalledTimes(expectedCalls);
			expect((onRibbonChange.mock.calls.at(-1)?.[0] as RibbonSettings).layout).toBe(layout);
			output = stripAnsi(list.render(120).join("\n"));
			expect(output).toMatch(new RegExp(`Status bar layout\\s+${label}`));
		}
	});

	it("cycles status bar location and toggles the status bar border", () => {
		const onRibbonChange = vi.fn();
		const config = {
			ribbon: { ...DEFAULT_RIBBON_SETTINGS },
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
			currentTheme: "dark",
			steeringMode: "all",
			followUpMode: "all",
			transport: "auto",
			httpIdleTimeoutMs: 300000,
			mermaidRenderingMode: "streaming",
			defaultProjectTrust: "ask",
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			tuiMode: "regular",
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
		} as unknown as SettingsConfig;
		const callbacks = { onRibbonChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("status-bar-location");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Status bar location\s+Top/);

		// Cycle to Bottom
		list.handleInput("\r");
		expect(onRibbonChange).toHaveBeenCalledTimes(1);
		expect((onRibbonChange.mock.calls[0][0] as RibbonSettings).location).toBe("bottom");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Status bar location\s+Bottom/);

		// Cycle back to Top
		list.handleInput("\r");
		expect(onRibbonChange).toHaveBeenCalledTimes(2);
		expect((onRibbonChange.mock.calls[1][0] as RibbonSettings).location).toBe("top");

		list.selectItem("status-bar-border");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Status bar border\s+false/);

		list.handleInput("\r"); // toggle border on
		expect(onRibbonChange).toHaveBeenCalledTimes(3);
		expect((onRibbonChange.mock.calls[2][0] as RibbonSettings).border).toBe(true);
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Status bar border\s+true/);
	});

	it("displays and updates input indicator via submenu", () => {
		const onInputIndicatorChange = vi.fn();
		const config = {
			ribbon: { ...DEFAULT_RIBBON_SETTINGS },
			inputIndicator: ">",
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
			currentTheme: "dark",
			steeringMode: "all",
			followUpMode: "all",
			transport: "auto",
			httpIdleTimeoutMs: 300000,
			mermaidRenderingMode: "streaming",
			defaultProjectTrust: "ask",
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			tuiMode: "regular",
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
		} as unknown as SettingsConfig;
		const callbacks = {
			onInputIndicatorChange,
		} as unknown as SettingsCallbacks;

		const selector = new SettingsSelectorComponent(config, callbacks);
		const list = selector.getSettingsList();
		list.selectItem("input-indicator");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Input indicator\s+>/);

		// Open submenu
		list.handleInput("\r");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("Set the prompt indicator shown before your input");

		// Type new indicator: backspace then "$" then Enter
		list.handleInput("\x7f");
		list.handleInput("$");
		list.handleInput("\r");

		expect(onInputIndicatorChange).toHaveBeenCalledWith("$");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Input indicator\s+\$/);
	});

	it("cancels input indicator submenu without saving", () => {
		const onInputIndicatorChange = vi.fn();
		const config = {
			ribbon: { ...DEFAULT_RIBBON_SETTINGS },
			inputIndicator: ">",
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
			currentTheme: "dark",
			steeringMode: "all",
			followUpMode: "all",
			transport: "auto",
			httpIdleTimeoutMs: 300000,
			mermaidRenderingMode: "streaming",
			defaultProjectTrust: "ask",
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			tuiMode: "regular",
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
		} as unknown as SettingsConfig;
		const callbacks = {
			onInputIndicatorChange,
		} as unknown as SettingsCallbacks;

		const selector = new SettingsSelectorComponent(config, callbacks);
		const list = selector.getSettingsList();
		list.selectItem("input-indicator");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("Set the prompt indicator shown before your input");

		// Press Escape
		list.handleInput("\x1b");
		expect(onInputIndicatorChange).not.toHaveBeenCalled();
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(/Input indicator\s+>/);
	});
});
