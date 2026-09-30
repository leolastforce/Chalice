import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const LOGO = [
	"   █████████  █████                ████   ███                   ",
	"  ███░░░░░███░░███                ░░███  ░░░                    ",
	" ███     ░░░  ░███████    ██████   ░███  ████   ██████   ██████ ",
	"░███          ░███░░███  ░░░░░███  ░███ ░░███  ███░░███ ███░░███",
	"░███          ░███ ░███   ███████  ░███  ░███ ░███ ░░░ ░███████ ",
	"░░███     ███ ░███ ░███  ███░░███  ░███  ░███ ░███  ███░███░░░  ",
	" ░░█████████  ████ █████░░████████ █████ █████░░██████ ░░██████ ",
	"  ░░░░░░░░░  ░░░░ ░░░░░  ░░░░░░░░ ░░░░░ ░░░░░  ░░░░░░   ░░░░░░  ",
];

const colorizeLogoLine = (line: string, row: number, lineCount: number): string => {
	const accentAnsi = theme.getFgAnsi("accent");
	const match = accentAnsi.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/);
	if (!match) return theme.fg("accent", line);

	const accent = [Number(match[1]), Number(match[2]), Number(match[3])];
	const progress = lineCount <= 1 ? 0.5 : row / (lineCount - 1);
	const centerDistance = Math.abs(progress * 2 - 1);
	const brightness = 0.72 + (1 - centerDistance) * 0.25;
	const rgb = accent.map((channel) =>
		Math.round(brightness <= 1 ? channel * brightness : channel + (255 - channel) * (brightness - 1)),
	);
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${line}\x1b[39m`;
};
const SIDE_DECORATION = ["│  ", "│  ", "│  ", "│  ", "│  ", "│  ", "│  ", "│  "];

/*
const SIDE_DECORATION = [
  "  *    .  *       .             *      ",
  "                         *             ",
  " *   .        *       .       .       *",
  "   .     *                             ",
  "           .     .  *        *         ",
  "       .                .        .     ",
  ".  *           *                     * ",
  "                             .         ",
];
*/

const LOGO_WIDTH = Math.max(...LOGO.map(visibleWidth));
const DECORATION_WIDTH = Math.max(...SIDE_DECORATION.map(visibleWidth));
const COLUMN_GAP = 3;

/** Brand-only header shown in place of the resource-heavy welcome screen during onboarding. */
export class OnboardingHeaderComponent implements Component {
	render(width: number): string[] {
		if (width <= 0) return [];

		const groupWidth = LOGO_WIDTH + COLUMN_GAP + DECORATION_WIDTH;
		const leftHalfWidth = Math.floor(width / 2);
		const leftOffset = Math.min(Math.max(0, width - 1), Math.max(2, Math.floor((leftHalfWidth - groupWidth) / 2)));
		const availableWidth = Math.max(0, width - leftOffset);
		const useLogo = availableWidth >= LOGO_WIDTH;
		const logo = useLogo
			? LOGO.map((line, index) => colorizeLogoLine(line, index, LOGO.length))
			: [theme.fg("accent", "CHALICE")];
		const logoWidth = useLogo ? LOGO_WIDTH : Math.min(visibleWidth(logo[0] ?? ""), availableWidth);
		const gap = Math.min(COLUMN_GAP, Math.max(0, availableWidth - logoWidth));
		const decorationWidth = Math.min(DECORATION_WIDTH, Math.max(0, availableWidth - logoWidth - gap));
		const rows = Math.max(logo.length, SIDE_DECORATION.length);
		const logoTop = Math.floor((rows - logo.length) / 2);

		return Array.from({ length: rows }, (_, row) => {
			const logoLine = logo[row - logoTop] ?? "";
			const decorationLine = SIDE_DECORATION[row] ?? "";
			const logoText = theme.bold(truncateToWidth(logoLine, logoWidth, ""));
			const decorationText = theme.fg("muted", truncateToWidth(decorationLine, decorationWidth, ""));
			const logoPadding = Math.max(0, logoWidth - visibleWidth(logoText));
			return `${" ".repeat(logoPadding + gap)}${decorationText}${" ".repeat(leftOffset)}${logoText}`;
		});
	}

	invalidate(): void {}
	dispose(): void {}
}
