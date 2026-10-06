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
		expect(output).toContain("Below Input Bar Stats");
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
});
