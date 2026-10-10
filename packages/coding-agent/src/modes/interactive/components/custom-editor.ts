import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";
import type { StatusIndicator } from "./status-indicator.ts";

/** Side of the input the ribbon (status bar) is rendered on. */
export type RibbonLocation = "top" | "bottom";

/** Horizontal position of the ribbon within the input width. */
export type RibbonLayout = "left" | "right";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
	/** Render a powerline-style suffix inline with the first input row. */
	ribbon?: (width: number) => string;
	/** Which side of the input the ribbon renders on. Default: "bottom". */
	ribbonLocation?: RibbonLocation;
	/** Render a dynamic border on the side of the input opposite the ribbon. Default: false. */
	ribbonBorder?: boolean;
	/** Horizontal position of the ribbon within the input width. Default: "left". */
	ribbonLayout?: RibbonLayout;
	/** Prompt indicator string (default: ">", max 49 chars). */
	inputIndicator?: string;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	private promptColor: (text: string) => string;
	private ribbon?: (width: number) => string;
	private ribbonLocation: RibbonLocation;
	private ribbonBorder: boolean;
	private ribbonLayout: RibbonLayout;
	/** Number of rows this component prepends above the base editor content (top ribbon/border). */
	private renderedTopOffset = 0;
	private inputIndicator: string;
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.promptColor = theme.promptColor ?? theme.borderColor;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
		this.ribbon = options?.ribbon;
		this.ribbonLocation = options?.ribbonLocation ?? "bottom";
		this.ribbonBorder = options?.ribbonBorder ?? false;
		this.ribbonLayout = options?.ribbonLayout ?? "left";
		this.inputIndicator = options?.inputIndicator ?? ">";
	}

	setRibbon(ribbon: ((width: number) => string) | undefined): void {
		this.ribbon = ribbon;
		this.tui.requestRender();
	}

	setRibbonLocation(location: RibbonLocation): void {
		if (this.ribbonLocation === location) return;
		this.ribbonLocation = location;
		this.tui.requestRender();
	}

	setRibbonBorder(enabled: boolean): void {
		if (this.ribbonBorder === enabled) return;
		this.ribbonBorder = enabled;
		this.tui.requestRender();
	}

	setRibbonLayout(layout: RibbonLayout): void {
		if (this.ribbonLayout === layout) return;
		this.ribbonLayout = layout;
		this.tui.requestRender();
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}
	setInputIndicator(indicator: string): void {
		this.inputIndicator = indicator;
		this.tui.requestRender();
	}

	getInputIndicator(): string {
		return this.inputIndicator;
	}

	protected override hasTopBorder(): boolean {
		return false;
	}

	protected override hasBottomBorder(): boolean {
		return false;
	}

	protected override renderInlineContentLine(
		displayText: string,
		frameWidth: number,
		paddingX: number,
		_lineVisibleWidth: number,
		_cursorInPadding: boolean,
		isFirstLine: boolean,
	): string | undefined {
		if (!isFirstLine) return undefined;

		const contentWidth = Math.max(1, frameWidth - paddingX * 2);
		const indicator = this.inputIndicator;
		const indicatorSuffix = indicator.length === 0 ? "" : indicator.endsWith(" ") ? indicator : `${indicator} `;
		const indicatorWidth = visibleWidth(indicatorSuffix);
		const maxWorkingWidth = Math.max(0, contentWidth - indicatorWidth - (indicatorSuffix.length > 0 ? 1 : 0));
		const working = this.workingStatusIndicator?.renderSpinnerInBorder(maxWorkingWidth) ?? "";
		let prompt =
			indicator.length === 0
				? working.length > 0
					? `${working} `
					: ""
				: working.length > 0
					? `${working} ${indicatorSuffix}`
					: indicatorSuffix;
		if (visibleWidth(prompt) >= contentWidth) {
			prompt = truncateToWidth(prompt, Math.max(0, contentWidth - 1), "");
		}
		const inputWidth = Math.max(1, contentWidth - visibleWidth(prompt));
		const input = truncateToWidth(displayText, inputWidth, "…");
		const padding = " ".repeat(Math.max(0, inputWidth - visibleWidth(input)));
		const left = " ".repeat(paddingX);
		return `${left}${this.promptColor(prompt)}${input}${padding}${left}`;
	}

	/** Pads the ribbon text so it sits at the configured layout position within contentWidth. */
	private alignRibbon(text: string, contentWidth: number): string {
		switch (this.ribbonLayout) {
			case "right":
				return " ".repeat(Math.max(0, contentWidth - visibleWidth(text))) + text;
			default:
				return text;
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const frameInset = Math.max(0, this.getFrameInset());
		const frameWidth = Math.max(1, width - frameInset * 2);
		const maxPadding = Math.max(0, Math.floor((frameWidth - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const contentWidth = Math.max(1, frameWidth - paddingX * 2);
		const ribbon = this.ribbon?.(contentWidth) ?? "";
		const ribbonText = ribbon.length > 0 ? truncateToWidth(ribbon, contentWidth, "...") : "";
		const ribbonAligned = this.alignRibbon(ribbonText, contentWidth);
		const ribbonLine =
			ribbonText.length > 0
				? this.renderContentLine(ribbonAligned, frameWidth, paddingX, visibleWidth(ribbonAligned))
				: undefined;
		// The border sits on the side opposite the ribbon: a bottom border uses the bottom-left
		// corner, a top border the top-left corner.
		const borderCorner = this.ribbonLocation === "top" ? "╰" : "╭";
		const borderLine = this.ribbonBorder
			? theme.fg("accent", `${borderCorner}${"─".repeat(Math.max(0, width - 1))}`)
			: undefined;

		if (this.ribbonLocation === "top") {
			if (borderLine) lines.push(borderLine);
			if (ribbonLine) lines.unshift(ribbonLine);
			this.renderedTopOffset = ribbonLine ? 1 : 0;
		} else {
			if (ribbonLine) lines.push(ribbonLine);
			if (borderLine) lines.unshift(borderLine);
			this.renderedTopOffset = borderLine ? 1 : 0;
		}
		return lines;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// The base editor's mouse geometry assumes its content starts at row 1. When this
		// component prepends the ribbon (and/or border) above the content, shift the incoming
		// row so clicks still map to the correct visual line. Rows inside the prepended
		// area only focus the editor.

		if (this.renderedTopOffset <= 0) return super.handleMouse(event);

		const localY = event.y - this.renderedTopOffset;
		if (localY <= 0) return { handled: true, focus: true };
		return super.handleMouse({ ...event, y: localY });
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Mode cycling - only if autocomplete is NOT active, so Tab still accepts a suggestion when
		// the list is open. Unbinding the action restores the editor's Tab path completion.
		if (this.keybindings.matches(data, "app.mode.cycle")) {
			if (!this.isShowingAutocomplete()) {
				const handler = this.actionHandlers.get("app.mode.cycle");
				if (handler) {
					handler();
					return;
				}
			}
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
