/**
 * TUI rendering for the `show_plan` tool result.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";

export interface PlanDetails {
  markdown?: string;
  path?: string;
  error?: string;
}

export function makeMarkdownTheme(theme: Theme): MarkdownTheme {
  const f = (color: string) => (t: string) => theme.fg(color as never, t);
  return {
    heading: f("mdHeading"),
    link: f("mdLink"),
    linkUrl: f("mdLinkUrl"),
    code: f("mdCode"),
    codeBlock: f("mdCodeBlock"),
    codeBlockBorder: f("mdCodeBlockBorder"),
    quote: f("mdQuote"),
    quoteBorder: f("mdQuoteBorder"),
    hr: f("mdHr"),
    listBullet: f("mdListBullet"),
    bold: (t: string) => theme.bold(t),
    italic: (t: string) => theme.italic(t),
    strikethrough: (t: string) => theme.strikethrough(t),
    underline: (t: string) => theme.underline(t),
  } as MarkdownTheme;
}

export function renderPlanResult(theme: Theme, details: PlanDetails | undefined) {
  const d = details ?? {};
  if (d.error) return new Text(theme.fg("error", d.error), 0, 0);
  const container = new Container();
  if (d.path) container.addChild(new Text(theme.fg("muted", `plan · ${d.path}`), 0, 0));
  container.addChild(new Markdown(d.markdown ?? "(empty plan)", 0, 0, makeMarkdownTheme(theme)));
  return container;
}
