import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
	/** Render compact model/context information in the editor's top border. */
	topLine?: (width: number) => string;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	private topLine?: (width: number) => string;
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
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
		this.topLine = options?.topLine;
	}

	setTopLine(topLine: ((width: number) => string) | undefined): void {
		this.topLine = topLine;
		this.tui.requestRender();
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	protected override getFrameInset(): number {
		return 1;
	}

	protected override renderContentLine(
		displayText: string,
		frameWidth: number,
		paddingX: number,
		lineVisibleWidth: number,
		cursorInPadding = false,
	): string {
		return (
			this.borderColor("│") +
			super.renderContentLine(displayText, frameWidth, paddingX, lineVisibleWidth, cursorInPadding) +
			this.borderColor("│")
		);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const innerWidth = Math.max(0, width - 2);
		const status = this.workingStatusIndicator
			? this.workingStatusIndicator.renderInBorder(Math.max(1, innerWidth - 2))
			: "";
		const stats = this.topLine?.(Math.max(1, innerWidth - 2)) ?? "";
		const scroll = hiddenLineCount > 0 ? `↑ ${hiddenLineCount} more` : "";
		const labels = [status, stats, scroll].filter((label) => label.length > 0).join(" · ");
		const label = truncateToWidth(labels, Math.max(0, innerWidth - 2), "...");
		const labelWidth = visibleWidth(label);
		return (
			this.borderColor("╭─") + label + this.borderColor(`${"─".repeat(Math.max(0, innerWidth - labelWidth - 2))}─╮`)
		);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		const innerWidth = Math.max(0, width - 2);
		const border = super.renderBottomBorder(innerWidth, hiddenLineCount);
		return this.borderColor("╰") + border + this.borderColor("╯");
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
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
