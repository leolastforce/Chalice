import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Format token counts for compact footer display. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Chalice interaction mode shown in the footer. */
export type ChaliceMode = "Change" | "Think" | "Review" | "Debug";

/** Order used by the `app.mode.cycle` keybinding. */
export const CHALICE_MODES: readonly ChaliceMode[] = ["Change", "Think", "Review", "Debug"];

/** Footer component that shows extension status line. */
export class FooterComponent implements Component {
	private footerData: ReadonlyFooterDataProvider;

	constructor(footerData: ReadonlyFooterDataProvider) {
		this.footerData = footerData;
	}

	setMode(_mode: ChaliceMode): void {
		// Mode is rendered in the editor ribbon, not the footer.
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// Context usage is shown in the editor ribbon, not the footer.
	}

	/** No-op: git branch caching is handled by the provider. */
	invalidate(): void {}

	/** Git watcher cleanup is handled by the provider. */
	dispose(): void {}

	render(width: number): string[] {
		const lines = [""];

		if (areExperimentalFeaturesEnabled()) {
			lines.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		const extensionStatuses = [...this.footerData.getExtensionStatuses()].filter(
			([key]) => key !== "code-index" && key !== "mcp",
		);
		if (extensionStatuses.length > 0) {
			const statusLine = extensionStatuses
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
