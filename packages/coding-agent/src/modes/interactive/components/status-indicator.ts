import { type Component, Loader, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	renderInline(width: number): string {
		const message = this.getRenderedMessage();
		const indicator = this.getRenderedIndicator();
		const line = [message, indicator].filter((part) => part.length > 0).join(" ");
		return truncateToWidth(line, width, "");
	}

	dispose(): void {
		this.stop();
	}
}

const WORKING_SPINNER_INTERVAL_MS = 80;
const WORKING_SPINNER_FRAMES = ["·", "·", "•", "•", "●", "●", "•", "•"];

export class WorkingStatusIndicator extends StatusIndicator {
	private useDefaultIndicator = false;
	private indicatorColor?: (text: string) => string;

	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions, colorFn?: (text: string) => string) {
		super(
			"working",
			ui,
			colorFn ?? ((text) => theme.fg("accent", text)),
			(text) => theme.fg("muted", text),
			message,
			indicator,
		);
		this.indicatorColor = colorFn ?? ((text) => theme.fg("accent", text));
		this.setIndicator(indicator);
	}

	override setIndicator(indicator?: WorkingIndicatorOptions): void {
		this.useDefaultIndicator = indicator === undefined;
		super.setIndicator(indicator ?? { frames: WORKING_SPINNER_FRAMES, intervalMs: WORKING_SPINNER_INTERVAL_MS });
	}

	protected override getRenderedIndicator(): string {
		const frame = super.getRenderedIndicator();
		return this.useDefaultIndicator
			? (this.indicatorColor ?? ((text: string) => theme.fg("accent", text)))(frame)
			: frame;
	}

	protected override getRenderedMessage(): string {
		return "";
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
