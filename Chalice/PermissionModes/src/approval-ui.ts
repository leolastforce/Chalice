import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";

function styleDiff(diff: string, theme: Theme): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("success", line);
      if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("error", line);
      if (line.startsWith("@@")) return theme.fg("accent", line);
      return line;
    })
    .join("\n");
}

export async function showResultApproval(
  ctx: ExtensionContext,
  changedPaths: number,
  diff: string,
): Promise<boolean> {
  if (ctx.mode !== "tui") return false;

  return ctx.ui.custom<boolean>((tui, theme, keybindings: KeybindingsManager, done) => {
    let scrollTop = 0;
    let selectedAction = 1;

    const component: Component & { handleInput(data: string): void; invalidate(): void } = {
      render(width: number): string[] {
        const innerWidth = Math.max(1, width - 4);
        const body = new Text(styleDiff(diff || "(No textual diff available)", theme), 0, 0).render(innerWidth);
        const pageSize = Math.max(1, Math.min(tui.terminal.rows - 12, Math.floor(tui.terminal.rows * 0.65)));
        const maxScroll = Math.max(0, body.length - pageSize);
        scrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
        const actionText = selectedAction === 0
          ? `${theme.bg("selectedBg", theme.fg("text", theme.bold(" Approve Result ")))}  ${theme.fg("dim", "Deny Result")}`
          : `${theme.fg("dim", "Approve Result")}  ${theme.bg("selectedBg", theme.fg("text", theme.bold(" Deny Result ")))}`;
        const lines = [
          theme.bold(theme.fg("accent", "Review Result")),
          theme.fg("dim", `${changedPaths} workspace path${changedPaths === 1 ? "" : "s"} changed. Originals are unchanged until approval.`),
          theme.fg("dim", "Changes made outside the workspace are not covered by this review."),
          theme.fg("border", "─".repeat(Math.max(1, width))),
          ...body.slice(scrollTop, scrollTop + pageSize),
          theme.fg("border", "─".repeat(Math.max(1, width))),
          `${theme.fg("dim", "↑/↓ choose · PgUp/PgDn scroll · Enter select · Esc deny")}  ${actionText}`,
        ];
        return lines.map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string): void {
        if (keybindings.matches(data, "tui.select.cancel")) {
          done(false);
          return;
        }
        if (keybindings.matches(data, "tui.select.up")) {
          selectedAction = selectedAction === 0 ? 1 : 0;
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.down")) {
          selectedAction = selectedAction === 0 ? 1 : 0;
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.pageUp")) {
          scrollTop = Math.max(0, scrollTop - Math.max(1, tui.terminal.rows - 14));
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.pageDown")) {
          scrollTop += Math.max(1, tui.terminal.rows - 14);
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) done(selectedAction === 0);
      },
      invalidate(): void {},
    };

    return component;
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "95%", minWidth: 40, maxHeight: "90%", margin: 1 },
  });
}
