import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("status bar animation lifecycle", () => {
	afterEach(() => vi.useRealTimers());

	it("starts once, advances while working, and stops on agent end or shutdown", async () => {
		vi.useFakeTimers();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		const state = mode as unknown as {
			isInitialized: boolean;
			footer: { invalidate: () => void; dispose: () => void };
			footerDataProvider: { dispose: () => void };
			ui: { requestRender: () => void };
			pendingTools: Map<string, unknown>;
			settingsManager: { getShowTerminalProgress: () => boolean };
			clearStatusIndicator: () => void;
			disposeActiveSelector: () => void;
			setOnboardingHeader: () => void;
			themeController: { disableAutoSync: () => void };
			clearExtensionTerminalInputListeners: () => void;
			unregisterSignalHandlers: () => void;
			ribbonAnimationFrame: number | undefined;
			handleEvent: (event: { type: "agent_start" | "agent_end" }) => Promise<void>;
		};
		Object.assign(state, {
			isInitialized: true,
			footer: { invalidate: vi.fn(), dispose: vi.fn() },
			footerDataProvider: { dispose: vi.fn() },
			ui: { requestRender: vi.fn() },
			pendingTools: new Map(),
			clearStatusIndicator: vi.fn(),
			disposeActiveSelector: vi.fn(),
			setOnboardingHeader: vi.fn(),
			themeController: { disableAutoSync: vi.fn() },
			clearExtensionTerminalInputListeners: vi.fn(),
			unregisterSignalHandlers: vi.fn(),
		});
		Object.defineProperty(state, "settingsManager", { value: { getShowTerminalProgress: () => false } });
		await state.handleEvent({ type: "agent_start" });
		await state.handleEvent({ type: "agent_start" });
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(160);
		expect(state.ribbonAnimationFrame).toBe(1);
		await state.handleEvent({ type: "agent_end" });
		expect(state.ribbonAnimationFrame).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		await state.handleEvent({ type: "agent_start" });
		state.isInitialized = false;
		mode.stop("transcript");
		expect(state.ribbonAnimationFrame).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});
});
