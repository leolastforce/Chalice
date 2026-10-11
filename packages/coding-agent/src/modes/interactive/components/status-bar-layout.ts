import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusBarLayout, StatusBarStyle } from "../../../core/settings-manager.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";

/** Status bar stats grouped by where they render: left side, optional centered stat, right side. */
export interface StatusBarPlacement<T> {
	left: T[];
	center?: T;
	right: T[];
}

/**
 * Assigns stats to positions. "left" and "right" keep every stat on one side.
 * "middle" centers the median stat (or `pinned`) and alternates the others: left, right, left, ...
 */
export function placeStatusBarStats<T>(
	stats: readonly T[],
	layout: StatusBarLayout,
	pinned?: T,
): StatusBarPlacement<T> {
	if (layout === "left") return { left: [...stats], right: [] };
	if (layout === "right") return { left: [], right: [...stats] };
	const center = pinned ?? stats[Math.floor(stats.length / 2)];
	const others = stats.filter((stat) => stat !== center);
	return {
		left: others.filter((_stat, index) => index % 2 === 0),
		center,
		right: others.filter((_stat, index) => index % 2 === 1),
	};
}

/** Renders a powerline group with the requested edge direction. */
export function renderPowerlineGroup(
	segments: readonly string[],
	background: string,
	backgroundForeground: string,
	separator: string,
	direction: "left" | "center" | "right",
): string {
	if (segments.length === 0) return "";
	const isRight = direction === "right";
	const orderedSegments = segments;
	let rendered = direction === "left" ? "" : `${backgroundForeground}\x1b[49m`;
	for (let i = 0; i < orderedSegments.length; i++) {
		if (i === 0) {
			rendered += `${background} ${orderedSegments[i]} `;
		} else {
			rendered += `${background}${separator}${isRight ? "" : ""} ${orderedSegments[i]} `;
		}
	}
	if (direction === "right") return `${rendered}\x1b[49m`;
	return `${rendered}${backgroundForeground}\x1b[49m`;
}
/**
 * Joins rendered groups into one line of `width` columns. The center group is placed at the
 * middle of the line, and the right group is flush with the right edge. Overflow is truncated.
 */
export function composeStatusBarLine(
	parts: { left: string; center?: string; right: string },
	width: number,
	filler = " ",
): string {
	const leftWidth = visibleWidth(parts.left);
	const rightWidth = visibleWidth(parts.right);
	if (parts.center === undefined) {
		const gap = parts.right === "" ? 0 : Math.max(0, width - leftWidth - rightWidth);
		const between = parts.left !== "" && parts.right !== "" ? filler.repeat(gap) : " ".repeat(gap);
		return truncateToWidth(`${parts.left}${between}${parts.right}`, width, "...");
	}
	const centerWidth = visibleWidth(parts.center);
	const centerStart = Math.max(leftWidth, Math.floor((width - centerWidth) / 2));
	const rightStart = Math.max(centerStart + centerWidth, width - rightWidth);
	const beforeCenter = (parts.left !== "" ? filler : " ").repeat(centerStart - leftWidth);
	const beforeRight = (parts.right !== "" ? filler : " ").repeat(rightStart - centerStart - centerWidth);
	return truncateToWidth(`${parts.left}${beforeCenter}${parts.center}${beforeRight}${parts.right}`, width, "...");
}

export type StatusBarSegment = [label: string, styled: string, color: ThemeColor];

export interface StatusBarRenderOptions {
	style?: StatusBarStyle;
	layout?: StatusBarLayout;
	pinnedSegment?: StatusBarSegment;
}

function scaleAnsi(color: ThemeColor, factor: number, code: 38 | 48): string {
	return theme
		.getFgAnsi(color)
		.replace(
			/\x1b\[38;2;(\d+);(\d+);(\d+)m/g,
			(_match: string, red: string, green: string, blue: string) =>
				`\x1b[${code};2;${Math.round(Number(red) * factor)};${Math.round(Number(green) * factor)};${Math.round(Number(blue) * factor)}m`,
		)
		.replace(/\x1b\[38;5;(\d+)m/g, (_match: string, value: string) => {
			const index = Number(value);
			if (index >= 16 && index <= 231) {
				const cubeIndex = index - 16;
				const red = Math.round(Math.floor(cubeIndex / 36) * factor);
				const green = Math.round(Math.floor((cubeIndex % 36) / 6) * factor);
				const blue = Math.round((cubeIndex % 6) * factor);
				return `\x1b[${code};5;${16 + red * 36 + green * 6 + blue}m`;
			}
			if (index >= 232) {
				return `\x1b[${code};5;${232 + Math.round((index - 232) * factor)}m`;
			}
			return `\x1b[${code};5;${index}m`;
		});
}

function renderSegments(
	group: readonly StatusBarSegment[],
	style: StatusBarStyle,
	powerlineDirection: "left" | "center" | "right" = "left",
): string {
	if (group.length === 0) return "";
	if (style === "minimal") {
		return group
			.map(([_label, styled, color], index) => {
				const sep = index < group.length - 1 ? theme.fg(color, "─") : "";
				return `[${styled}]${sep}`;
			})
			.join("");
	}
	if (style === "powerline") {
		const BACKGROUND_FACTOR = 0.12;
		const SEPARATOR_FACTOR = 0.22;
		const bg = scaleAnsi("accent", BACKGROUND_FACTOR, 48);
		const separator = scaleAnsi("accent", SEPARATOR_FACTOR, 38);
		const backgroundForeground = bg.replace("[48;", "[38;");
		return renderPowerlineGroup(
			group.map(([_label, styled]) => styled),
			bg,
			backgroundForeground,
			separator,
			powerlineDirection,
		);
	}
	return group
		.map(([_label, styled, color]) => {
			const background = scaleAnsi(color, 0.35, 48);
			const separator = background.replace("[48;", "[38;");
			return `${separator}${background} ${styled} \x1b[49m${separator}`;
		})
		.join("─");
}

/**
 * Formats and renders the full status bar line for given segments, options and width.
 */
export function renderStatusBar(
	segments: readonly StatusBarSegment[],
	options: StatusBarRenderOptions,
	width: number,
): string {
	const style = options.style ?? "rounded";
	const layout = options.layout ?? "middle";
	const placement = placeStatusBarStats(segments, layout, options.pinnedSegment);
	return composeStatusBarLine(
		{
			left: renderSegments(placement.left, style),
			center: placement.center ? renderSegments([placement.center], style, "center") : undefined,
			right: renderSegments(placement.right, style, "right"),
		},
		width,
		layout === "middle" ? "─" : " ",
	);
}
