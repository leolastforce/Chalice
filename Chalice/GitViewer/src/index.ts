import { spawn, type IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
  visibleWidth,
} from '@earendil-works/pi-tui';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;

const DEFAULT_WIDTH = '90%';
const DEFAULT_MAX_HEIGHT = '90%';
const DEFAULT_MIN_WIDTH = 60;
const DEFAULT_MIN_ROWS = 10;
const DEFAULT_MAX_ROWS = 45;

type TerminalCellAttributes = {
  fgMode: number;
  bgMode: number;
  fgColor: number;
  bgColor: number;
  bold: number;
  italic: number;
  dim: number;
  underline: number;
  blink: number;
  inverse: number;
  invisible: number;
  strikethrough: number;
  overline: number;
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw || fallback;
}

function isSizeValue(value: string): value is `${number}%` {
  return /^\d+(?:\.\d+)?%$/.test(value);
}

function parseOverlaySize(value: string): number | `${number}%` {
  if (isSizeValue(value)) return value;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : value === '0'
      ? 0
      : DEFAULT_MIN_WIDTH;
}

function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && quote !== 'single') {
      escaping = true;
      continue;
    }

    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }

    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }

    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  if (current.length > 0) args.push(current);
  return args;
}

function shallowEqualAttributes(
  a: TerminalCellAttributes | null,
  b: TerminalCellAttributes,
): boolean {
  if (!a) return false;
  return (
    a.fgMode === b.fgMode &&
    a.bgMode === b.bgMode &&
    a.fgColor === b.fgColor &&
    a.bgColor === b.bgColor &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.dim === b.dim &&
    a.underline === b.underline &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.invisible === b.invisible &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline
  );
}

function themeAnsi(theme: Theme, mode: 'fg' | 'bg', color: number): string {
  if (mode === 'bg') return theme.getBgAnsi('selectedBg');
  const semantic = ['muted', 'error', 'success', 'warning', 'accent', 'accent', 'text', 'text'][color % 8] as Parameters<Theme['getFgAnsi']>[0];
  return theme.getFgAnsi(semantic);
}

function sgrForAttributes(attrs: TerminalCellAttributes, theme: Theme): string {
  const codes: string[] = ['0'];
  if (attrs.bold) codes.push('1');
  if (attrs.dim) codes.push('2');
  if (attrs.italic) codes.push('3');
  if (attrs.underline) codes.push('4');
  if (attrs.blink) codes.push('5');
  if (attrs.inverse) codes.push('7');
  if (attrs.invisible) codes.push('8');
  if (attrs.strikethrough) codes.push('9');
  if (attrs.overline) codes.push('53');

  // Map Lazygit's ANSI palette to semantic Chalice colors.
  const foreground = attrs.fgMode ? themeAnsi(theme, 'fg', attrs.fgColor) : '';
  const background = attrs.bgMode ? themeAnsi(theme, 'bg', attrs.bgColor) : '';
  return `\x1b[${codes.join(';')}m${foreground}${background}`;
}

function attributesFromCell(
  cell: ReturnType<
    NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>['getCell']
  >,
): TerminalCellAttributes | null {
  if (!cell) return null;

  let fgMode = 0;
  if (cell.isFgPalette()) fgMode = 1;
  if (cell.isFgRGB()) fgMode = 2;

  let bgMode = 0;
  if (cell.isBgPalette()) bgMode = 1;
  if (cell.isBgRGB()) bgMode = 2;

  return {
    fgMode,
    bgMode,
    fgColor: cell.getFgColor(),
    bgColor: cell.getBgColor(),
    bold: cell.isBold(),
    italic: cell.isItalic(),
    dim: cell.isDim(),
    underline: cell.isUnderline(),
    blink: cell.isBlink(),
    inverse: cell.isInverse(),
    invisible: cell.isInvisible(),
    strikethrough: cell.isStrikethrough(),
    overline: cell.isOverline(),
  };
}

function renderTerminalLine(term: Terminal, y: number, cols: number, theme: Theme): string {
  const line = term.buffer.active.getLine(y);
  if (!line) return ' '.repeat(cols);

  const reusableCell = term.buffer.active.getNullCell();
  let result = '';
  let currentAttrs: TerminalCellAttributes | null = null;

  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x, reusableCell);
    if (!cell || cell.getWidth() === 0) continue;

    const attrs = attributesFromCell(cell);
    if (attrs && !shallowEqualAttributes(currentAttrs, attrs)) {
      result += sgrForAttributes(attrs, theme);
      currentAttrs = attrs;
    }

    const chars = cell.getChars();
    result += chars.length > 0 ? chars : ' ';
  }

  return `${result}\x1b[0m`;
}

function insertCursorMarker(line: string, cursorX: number): string {
  if (cursorX <= 0) return CURSOR_MARKER + line;

  let visible = 0;
  let index = 0;
  const ansiPattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;

  while (index < line.length && visible < cursorX) {
    ansiPattern.lastIndex = index;
    const match = ansiPattern.exec(line);
    if (match) {
      index = ansiPattern.lastIndex;
      continue;
    }

    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    index += codePoint > 0xffff ? 2 : 1;
    visible += 1;
  }

  return `${line.slice(0, index)}${CURSOR_MARKER}${line.slice(index)}`;
}

class LazygitOverlay implements Component, Focusable {
  focused = false;

  private pty: IPty;
  private term: Terminal;
  private cols: number;
  private rows: number;
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly done: (result: {
      code: number | null;
      signal: number | null;
      forced: boolean;
    }) => void,
  ) {
    this.cols = this.computeCols(DEFAULT_MIN_WIDTH);
    this.rows = this.computeRows();
    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: 0,
      allowProposedApi: true,
    });

    this.pty = spawn(this.command, this.args, {
      name: process.env.TERM || 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
        COLORTERM: process.env.COLORTERM || 'truecolor',
      },
    });

    this.pty.onData((data) => {
      this.term.write(data, () => this.tui.requestRender());
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.exitSignal = signal ?? null;
      this.tui.requestRender();
      setTimeout(
        () =>
          this.done({
            code: this.exitCode,
            signal: this.exitSignal,
            forced: false,
          }),
        120,
      );
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+q')) {
      this.close(true);
      return;
    }

    if (this.exited) {
      this.done({
        code: this.exitCode,
        signal: this.exitSignal,
        forced: false,
      });
      return;
    }

    try {
      this.pty.write(data);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    this.resize(innerWidth, this.computeRows());

    const border = (text: string) => this.theme.fg('dim', text);
    const title = ` Lazygit ${this.exited ? '(finished)' : '(running)'} `;
    const titleWidth = visibleWidth(title);
    const topPadding = Math.max(0, innerWidth - titleWidth);
    const lines: string[] = [
      border('╭') +
        this.theme.bold(this.theme.fg('accent', title)) +
        border(`${'─'.repeat(topPadding)}╮`),
    ];

    const cursorY = this.term.buffer.active.cursorY;
    const cursorX = this.term.buffer.active.cursorX;

    for (let y = 0; y < this.rows; y++) {
      let content = renderTerminalLine(this.term, y, this.cols, this.theme);
      if (this.focused && y === cursorY) {
        content = insertCursorMarker(content, cursorX);
      }
      lines.push(
        border('│') +
          truncateToWidth(content, innerWidth, '', true) +
          border('│'),
      );
    }

    const status = this.statusText();
    lines.push(
      border('│') +
        truncateToWidth(` ${this.theme.fg('muted', status)}`, innerWidth, '', true) +
        border('│'),
    );
    lines.push(border(`╰${'─'.repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {}

  close(forced: boolean): void {
    if (!this.exited) {
      this.exited = true;
      try {
        this.pty.kill();
      } catch {
        // Process may have exited between keypress and kill.
      }
    }
    this.done({ code: this.exitCode, signal: this.exitSignal, forced });
  }

  private computeCols(width: number): number {
    return Math.max(20, width);
  }

  private computeRows(): number {
    const minRows = envNumber('PI_LAZYGIT_MIN_ROWS', DEFAULT_MIN_ROWS);
    const maxRows = envNumber('PI_LAZYGIT_MAX_ROWS', DEFAULT_MAX_ROWS);
    const availableRows = Math.max(minRows, this.tui.terminal.rows - 5);
    return Math.max(
      minRows,
      Math.min(maxRows, Math.floor(availableRows * 0.9)),
    );
  }

  private resize(cols: number, rows: number): void {
    const nextCols = this.computeCols(cols);
    const nextRows = Math.max(1, rows);
    if (nextCols === this.cols && nextRows === this.rows) return;

    this.cols = nextCols;
    this.rows = nextRows;
    this.term.resize(this.cols, this.rows);
    if (!this.exited) this.pty.resize(this.cols, this.rows);
  }

  private statusText(): string {
    if (this.lastError) return `Error: ${this.lastError} | Ctrl+Q close`;
    if (this.exited)
      return `Process exited with code ${this.exitCode ?? 'n/a'} | any key closes`;
    return 'q quits Lazygit | Ctrl+Q force closes overlay';
  }
}

export default function (pi: ExtensionAPI) {
  const openGitViewer = async (rawArgs: string, ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      ctx.ui.notify('Git viewer requires Chalice interactive mode.', 'error');
      return;
    }

    const command = envString('PI_LAZYGIT_COMMAND', 'lazygit');
    const args = parseArgs(rawArgs ?? '');

    try {
      const result = await ctx.ui.custom<{
        code: number | null;
        signal: number | null;
        forced: boolean;
      }>(
        (tui, theme, _keybindings, done) =>
          new LazygitOverlay(tui, theme, command, args, ctx.cwd, done),
        {
          overlay: true,
          overlayOptions: {
            width: parseOverlaySize(envString('PI_LAZYGIT_WIDTH', DEFAULT_WIDTH)),
            minWidth: envNumber('PI_LAZYGIT_MIN_WIDTH', DEFAULT_MIN_WIDTH),
            maxHeight: parseOverlaySize(envString('PI_LAZYGIT_MAX_HEIGHT', DEFAULT_MAX_HEIGHT)),
            anchor: 'center',
            margin: 1,
            visible: (termWidth, termHeight) => termWidth >= 70 && termHeight >= 18,
          },
        },
      );

      if (result.forced) ctx.ui.notify('Lazygit overlay closed.', 'info');
      else if (result.code && result.code !== 0) ctx.ui.notify(`Lazygit exited with code ${result.code}.`, 'warning');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to open Lazygit: ${message}`, 'error');
    }
  };

  pi.registerCommand('git', {
    description: 'Open git TUI lazygit',
    handler: openGitViewer,
  });

  pi.registerShortcut('shift+g', {
    description: 'Open git TUI lazygit',
    handler: (ctx) => openGitViewer('', ctx),
  });
}
