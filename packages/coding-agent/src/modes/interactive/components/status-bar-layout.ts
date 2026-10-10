import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusBarLayout } from "../../../core/settings-manager.ts";

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

/**
 * Joins rendered groups into one line of `width` columns. The center group is placed at the
 * middle of the line, and the right group is flush with the right edge. Overflow is truncated.
 */
export function composeStatusBarLine(parts: { left: string; center?: string; right: string }, width: number): string {
	const leftWidth = visibleWidth(parts.left);
	const rightWidth = visibleWidth(parts.right);
	if (parts.center === undefined) {
		const gap = parts.right === "" ? 0 : Math.max(0, width - leftWidth - rightWidth);
		return truncateToWidth(`${parts.left}${" ".repeat(gap)}${parts.right}`, width, "...");
	}
	const centerWidth = visibleWidth(parts.center);
	const centerStart = Math.max(leftWidth, Math.floor((width - centerWidth) / 2));
	const rightStart = Math.max(centerStart + centerWidth, width - rightWidth);
	const beforeCenter = " ".repeat(centerStart - leftWidth);
	const beforeRight = " ".repeat(rightStart - centerStart - centerWidth);
	return truncateToWidth(`${parts.left}${beforeCenter}${parts.center}${beforeRight}${parts.right}`, width, "...");
}
