import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

const LOGO_COLORS = ["#e8321c", "#f03a18", "#f54216", "#fa4f14", "#ff5a12", "#ff6812", "#ff7414", "#ff8218"];

const LOGO_ANIMATION_MAX = LOGO_COLORS.length * 6;
const colorLogo = (line: string, row: number, frame: number): string =>
	`${Array.from(line, (character, column) => {
		const colorIndex = Math.min(LOGO_COLORS.length - 1, Math.floor((column + row + frame) / 6));
		const color = LOGO_COLORS[colorIndex] ?? LOGO_COLORS[0]!;
		const hex = color.slice(1);
		const red = Number.parseInt(hex.slice(0, 2), 16);
		const green = Number.parseInt(hex.slice(2, 4), 16);
		const blue = Number.parseInt(hex.slice(4, 6), 16);
		return `\x1b[38;2;${red};${green};${blue}m${character}`;
	}).join("")}\x1b[39m`;

const SIDE_DECORATION = [""];

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
	private animationFrame = 0;
	private animationDirection = 1;
	private interval: ReturnType<typeof setInterval>;
	private ui: TUI;
	constructor(ui: TUI) {
		this.ui = ui;
		this.interval = setInterval(() => {
			this.animationFrame += this.animationDirection;
			if (this.animationFrame <= 0 || this.animationFrame >= LOGO_ANIMATION_MAX) {
				this.animationDirection *= -1;
			}
			this.ui.requestRender();
		}, 100);
	}
	render(width: number): string[] {
		if (width <= 0) return [];

		const groupWidth = LOGO_WIDTH + COLUMN_GAP + DECORATION_WIDTH;
		const leftHalfWidth = Math.floor(width / 2);
		const leftOffset = Math.min(Math.max(0, width - 1), Math.max(2, Math.floor((leftHalfWidth - groupWidth) / 2)));
		const availableWidth = Math.max(0, width - leftOffset);
		const useLogo = availableWidth >= LOGO_WIDTH;
		const logo = useLogo ? LOGO.map((line, index) => colorLogo(line, index, this.animationFrame)) : ["CHALICE"];
		const logoWidth = useLogo ? LOGO_WIDTH : Math.min(visibleWidth(logo[0] ?? ""), availableWidth);
		const gap = Math.min(COLUMN_GAP, Math.max(0, availableWidth - logoWidth));
		const decorationWidth = Math.min(DECORATION_WIDTH, Math.max(0, availableWidth - logoWidth - gap));
		const rows = Math.max(logo.length, SIDE_DECORATION.length);
		const logoTop = Math.floor((rows - logo.length) / 2);

		return Array.from({ length: rows }, (_, row) => {
			const logoLine = logo[row - logoTop] ?? "";
			const decorationLine = SIDE_DECORATION[row] ?? "";
			const logoText = theme.fg("accent", theme.bold(truncateToWidth(logoLine, logoWidth, "")));
			const decorationText = theme.fg("muted", truncateToWidth(decorationLine, decorationWidth, ""));
			const logoPadding = Math.max(0, logoWidth - visibleWidth(logoText));
			return `${" ".repeat(logoPadding + gap)}${decorationText}${" ".repeat(leftOffset)}${logoText}`;
			//return `${" ".repeat(leftOffset)}${logoText}${" ".repeat(logoPadding + gap)}${decorationText}`;
		});
	}

	invalidate(): void {}
	dispose(): void {
		clearInterval(this.interval);
	}
}
