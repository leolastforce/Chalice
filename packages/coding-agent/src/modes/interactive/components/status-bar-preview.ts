import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { RibbonSettings } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { renderStatusBar, type StatusBarSegment } from "./status-bar-layout.ts";

export interface StatusBarPreviewOptions {
	ribbon?: RibbonSettings;
	inputIndicator?: string;
	sampleText?: string;
	modelLabel?: string;
	thinkingLevel?: string;
}

export function createSampleStatusBarSegments(
	ribbon: RibbonSettings = {},
	modelLabel = "claude-sonnet-4-6",
	thinkingLevel?: string,
): {
	segments: StatusBarSegment[];
	pinnedSegment?: StatusBarSegment;
} {
	const segments: StatusBarSegment[] = [];
	if (ribbon.mode !== false) {
		segments.push(["default", theme.bold(theme.fg("accent", "default")), "accent"]);
	}
	if (ribbon.directory !== false) {
		segments.push(["chalice", theme.fg("muted", "chalice"), "muted"]);
	}
	if (ribbon.branch !== false) {
		segments.push(["main", theme.fg("success", "main"), "success"]);
	}
	let modelSegment: StatusBarSegment | undefined;
	if (ribbon.model !== false) {
		const fullLabel = thinkingLevel ? `${modelLabel} · ${thinkingLevel}` : modelLabel;
		const styledLabel = thinkingLevel
			? `${theme.fg("text", modelLabel)}${theme.fg("muted", " · ")}${theme.fg("warning", thinkingLevel)}`
			: theme.fg("text", modelLabel);
		modelSegment = [fullLabel, styledLabel, "text"];
		segments.push(modelSegment);
	}
	if (ribbon.cost !== false) {
		segments.push(["$0.00", theme.fg("warning", "$0.00"), "warning"]);
	}
	if (ribbon.contextPercent !== false) {
		segments.push(["5%", theme.fg("warning", "5%"), "warning"]);
	}
	if (ribbon.contextWindow !== false) {
		segments.push(["200k", theme.fg("dim", "200k"), "dim"]);
	}
	return { segments, pinnedSegment: modelSegment };
}

/**
 * Renders a live preview of the status bar, input indicator, sample prompt, and border.
 */
export class StatusBarPreviewComponent implements Component {
	private ribbon: RibbonSettings;
	private inputIndicator: string;
	private sampleText: string;
	private modelLabel: string;
	private thinkingLevel?: string;

	constructor(options?: StatusBarPreviewOptions) {
		this.ribbon = options?.ribbon ?? {};
		this.inputIndicator = options?.inputIndicator ?? ">";
		this.sampleText = options?.sampleText ?? "Type a message...";
		this.modelLabel = options?.modelLabel ?? "claude-sonnet-4-6";
		this.thinkingLevel = options?.thinkingLevel;
	}

	setRibbon(ribbon: RibbonSettings): void {
		this.ribbon = ribbon;
	}

	getRibbon(): RibbonSettings {
		return this.ribbon;
	}

	setInputIndicator(indicator: string): void {
		this.inputIndicator = indicator;
	}

	getInputIndicator(): string {
		return this.inputIndicator;
	}

	setSampleText(text: string): void {
		this.sampleText = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const pad = "  ";
		const contentWidth = Math.max(10, width - 4);

		// Status bar line
		const { segments, pinnedSegment } = createSampleStatusBarSegments(
			this.ribbon,
			this.modelLabel,
			this.thinkingLevel,
		);
		const statusBar = renderStatusBar(
			segments,
			{
				style: this.ribbon.style,
				layout: this.ribbon.layout,
				pinnedSegment,
			},
			contentWidth,
		);
		const statusBarLine = `${pad}${statusBar}`;

		// Input line
		const indicator = this.inputIndicator ? `${this.inputIndicator} ` : "";
		const promptColored = theme.fg("accent", indicator);
		const textColored = theme.fg("dim", this.sampleText);
		const inputLine = `${pad}${promptColored}${textColored}`;

		// Optional border line opposite to ribbon location
		const borderCorner = this.ribbon.location === "top" ? "╰" : "╭";
		const borderLine = this.ribbon.border
			? `${pad}${theme.fg("accent", `${borderCorner}${"─".repeat(Math.max(0, contentWidth - 1))}`)}`
			: undefined;

		const lines: string[] = [theme.fg("dim", `${pad}Preview:`)];

		if (this.ribbon.location === "top") {
			lines.push(statusBarLine);
			lines.push(inputLine);
			if (borderLine) lines.push(borderLine);
		} else {
			if (borderLine) lines.push(borderLine);
			lines.push(inputLine);
			lines.push(statusBarLine);
		}

		return lines.map((line) => truncateToWidth(line, width, "..."));
	}
}
