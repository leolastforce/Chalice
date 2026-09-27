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
    const logo = useLogo ? LOGO : ["CHALICE"];
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

  invalidate(): void { }
}
