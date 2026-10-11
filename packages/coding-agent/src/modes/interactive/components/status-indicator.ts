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

const WAVE_INTERVAL_MS = 120;
/** Characters within this distance of the wave peak light up. */
const WAVE_BAND = 2;

export class WorkingStatusIndicator extends StatusIndicator {
	private workingMessage: string | undefined;
	private wavePosition = 0;
	private waveInterval: ReturnType<typeof setInterval> | undefined;

	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions, colorFn?: (text: string) => string) {
		super(
			"working",
			ui,
			colorFn ?? ((text) => theme.fg("accent", text)),
			(text) => theme.fg("muted", text),
			message,
			indicator,
		);
		this.setMessage(message);
		this.waveInterval = setInterval(() => this.advanceWave(), WAVE_INTERVAL_MS);
	}

	override setMessage(message: string): void {
		this.workingMessage = message;
		this.wavePosition = 0;
		super.setMessage(message);
	}

	protected override getRenderedMessage(): string {
		const message = this.workingMessage;
		if (message === undefined) return super.getRenderedMessage();
		return Array.from(message, (character, index) => renderWaveCharacter(character, index, this.wavePosition)).join(
			"",
		);
	}

	override dispose(): void {
		if (this.waveInterval) clearInterval(this.waveInterval);
		this.waveInterval = undefined;
		super.dispose();
	}

	private advanceWave(): void {
		const length = Array.from(this.workingMessage ?? "").length;
		if (length === 0) return;
		this.wavePosition = (this.wavePosition + 1) % length;
		super.setMessage(this.workingMessage ?? "");
	}
}

/**
 * Colors one character of the working message for the travelling wave. The message rests in
 * the muted color, warms to the accent color as the wave arrives, and the peak is bold plus
 * underlined so it reads as a bump. Terminals cannot scale glyphs, so weight and underline
 * stand in for size instead of full-width characters that many fonts render as tofu.
 */
function renderWaveCharacter(character: string, index: number, wavePosition: number): string {
	const distance = Math.abs(index - wavePosition);
	if (distance > WAVE_BAND) return theme.fg("muted", character);
	if (distance === 0) return theme.fg("accent", `\x1b[1m\x1b[4m${character}\x1b[24m\x1b[22m`);
	if (distance === 1) return theme.fg("accent", `\x1b[1m${character}\x1b[22m`);
	return theme.fg("accent", character);
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
