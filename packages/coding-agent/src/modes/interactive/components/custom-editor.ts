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
	/** Render a powerline-style suffix inline with the first input row. */
	ribbon?: (width: number) => string;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	private ribbon?: (width: number) => string;
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
		this.ribbon = options?.ribbon;
	}

	setRibbon(ribbon: ((width: number) => string) | undefined): void {
		this.ribbon = ribbon;
		this.tui.requestRender();
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
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
		const prompt = "> ";
		const inputWidth = Math.max(1, contentWidth - visibleWidth(prompt));
		const input = truncateToWidth(displayText, inputWidth, "…");
		const padding = " ".repeat(Math.max(0, inputWidth - visibleWidth(input)));
		const left = " ".repeat(paddingX);
		return `${left}${this.borderColor(prompt)}${input}${padding}${left}`;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const frameInset = Math.max(0, this.getFrameInset());
		const frameWidth = Math.max(1, width - frameInset * 2);
		const maxPadding = Math.max(0, Math.floor((frameWidth - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const contentWidth = Math.max(1, frameWidth - paddingX * 2);
		const working = this.workingStatusIndicator?.renderInBorder(contentWidth) ?? "";
		const ribbon = this.ribbon?.(contentWidth) ?? "";
		const statusLine = [working, ribbon].filter((part) => part.length > 0).join("  ");
		if (statusLine.length > 0) {
			const rendered = truncateToWidth(statusLine, contentWidth, "...");
			lines.push(this.renderContentLine(rendered, frameWidth, paddingX, visibleWidth(rendered)));
		}
		return lines;
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
