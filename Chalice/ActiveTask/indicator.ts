import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

const FRAMES = [
	["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢", "·"],
	["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
	["·", "·", "•", "•", "●", "●", "•", "•"],
	["○", "○", "◉", "◉", "●", "●", "◉", "◉"],
	["·", "·", "✧", "✧", "✦", "✦", "✧", "✧"],
	["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	["⠁", "⠃", "⠇", "⠧", "⠷", "⠿", "⠷", "⠧", "⠇", "⠃"],
	["⠈", "⠉", "⠋", "⠛", "⠟", "⠿", "⠟", "⠛", "⠋", "⠉"],
	["◴", "◷", "◶", "◵"],
	["◐", "◓", "◑", "◒"],
	["◰", "◳", "◲", "◱"],
	["◇", "◆", "◇", "⋄"],
	["▪", "◼", "■", "◼"],
	["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎"],
	["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"],
	["⠁", "⠉", "⠙", "⠚", "⠒", "⠲", "⠴", "⠤"],
	["╱", "─", "╲", "│"],
	["+", "×", "+", "✳"],
	["⋄", "✧", "✦", "✧"],
	["▖", "▘", "▝", "▗"],
].flatMap((frames) => Array.from({ length: 40 }, (_, index) => frames[index % frames.length]));

export class ActivityIndicator implements Component {
	private frame = 0;
	private wave = 0;
	private readonly spinnerTimer: ReturnType<typeof setInterval>;
	private readonly waveTimer: ReturnType<typeof setInterval>;
	private readonly characters: string[];
	private readonly tui: TUI;
	private readonly theme: Theme;

	constructor(tui: TUI, theme: Theme, text: string) {
		this.tui = tui;
		this.theme = theme;
		this.characters = Array.from(text);
		this.spinnerTimer = setInterval(() => {
			this.frame = (this.frame + 1) % FRAMES.length;
			this.tui.requestRender();
		}, 80);
		this.waveTimer = setInterval(() => {
			this.wave = (this.wave + 1) % Math.max(1, this.characters.length);
			this.tui.requestRender();
		}, 120);
	}

	render(width: number): string[] {
		const indicator = this.theme.fg("accent", FRAMES[this.frame]);
		const message = this.characters.map((character, index) => {
			const distance = Math.abs(index - this.wave);
			if (distance > 2) return this.theme.fg("muted", character);
			if (distance === 0) return this.theme.fg("accent", `\x1b[1m\x1b[4m${character}\x1b[24m\x1b[22m`);
			if (distance === 1) return this.theme.fg("accent", `\x1b[1m${character}\x1b[22m`);
			return this.theme.fg("accent", character);
		}).join("");
		return [truncateToWidth(`${indicator} ${truncateToWidth(message, Math.max(0, width - 4))} ${indicator}`, width)];
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.spinnerTimer);
		clearInterval(this.waveTimer);
	}
}
