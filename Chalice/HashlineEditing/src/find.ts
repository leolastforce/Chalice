import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { globToRegex } from "./glob";
import { resolveRgPath } from "./grep";
import { toCwd, toDisplayPath } from "./paths";
import { loadP, loadGuide } from "./prompts";
import { normReq } from "./payload-contract";
import { errCode, isRec, makePrepareArguments, rejectUnknownFields } from "./utils";
import { Text } from "@earendil-works/pi-tui";
import { expandHint, getResultText, reuseText, type CallT, type FgT } from "./replace-render";

const FIND_KS = new Set(["pattern", "path", "limit"]);
const DEFAULT_LIMIT = 1000;

export interface FindReq {
  pattern: string;
  path?: string;
  limit?: number;
}

export function assertFindReq(request: unknown): asserts request is FindReq {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Find request must be an object.");
  }
  rejectUnknownFields(request, FIND_KS, "Find request");
  if (typeof request.pattern !== "string" || request.pattern.length === 0) {
    throw new Error('[E_BAD_SHAPE] Find request requires a non-empty "pattern" glob string.');
  }
  if (request.path !== undefined && typeof request.path !== "string") {
    throw new Error('[E_BAD_SHAPE] Find request field "path" must be a string when provided.');
  }
  if (request.limit !== undefined && (typeof request.limit !== "number" || !Number.isInteger(request.limit) || request.limit < 1)) {
    throw new Error('[E_BAD_SHAPE] Find request field "limit" must be a positive integer.');
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function collectRgFiles(rgPath: string, searchPath: string, signal?: AbortSignal): Promise<string[]> {
  const args = ["--files", "--hidden", "--no-require-git", "--glob", "!.git", "--null"];
  return await new Promise<string[]>((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd: searchPath, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      settle(() => reject(new Error("rg timeout")));
    }, 15000);
    const onAbort = () => {
      if (!child.killed) child.kill("SIGKILL");
      settle(() => reject(new Error("Operation aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        settle(() => reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`)));
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf-8");
      settle(() => resolve(raw.split("\0").filter((entry) => entry.length > 0)));
    });
  });
}

const findToolSchema = Type.Object(
  {
    pattern: Type.String({
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'. `*` crosses directories.",
    }),
    path: Type.Optional(
      Type.String({
        description: "Directory to search in (default: current directory). A file path is also accepted.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum number of results (default 1000)",
      }),
    ),
  },
  { additionalProperties: true },
);

const FIND_PREVIEW_LINES = 20;
const FIND_PREVIEW_LINES_EXPANDED = 60;

export function fmtFindCall(args: { pattern?: unknown; path?: unknown; limit?: unknown } | undefined, theme: CallT): string {
  const pattern = typeof args?.pattern === "string" && args.pattern.length > 0 ? theme.fg("accent", args.pattern) : theme.fg("toolOutput", "...");
  const qualifiers: string[] = [];
  if (typeof args?.path === "string" && args.path.length > 0) qualifiers.push(args.path);
  if (typeof args?.limit === "number") qualifiers.push(`limit ${args.limit}`);
  let text = `${theme.fg("toolTitle", theme.bold("find"))} ${pattern}`;
  if (qualifiers.length > 0) text += ` ${theme.fg("dim", qualifiers.join(" "))}`;
  return text;
}

function styleFindLine(line: string, theme: FgT): string {
  if (line.startsWith("[find:")) return theme.fg("dim", line);
  return line;
}

export function renderFindResult(
  result: { content?: Array<{ type: string; text?: string }> },
  options: { isPartial: boolean; expanded?: boolean } | boolean,
  theme: FgT,
  context: { isError?: boolean; expanded?: boolean; lastComponent?: unknown },
): Text {
  const isPartial = typeof options === "boolean" ? options : options.isPartial;
  const expanded = typeof options === "boolean" ? context.expanded === true : options.expanded === true || context.expanded === true;
  if (isPartial) return reuseText(context, theme.fg("warning", "Finding..."));
  const raw = getResultText(result);
  if (context.isError) return raw ? reuseText(context, `\n${theme.fg("error", raw)}`) : new Text("", 0, 0);
  if (!raw) return new Text("", 0, 0);
  const maxLines = expanded ? FIND_PREVIEW_LINES_EXPANDED : FIND_PREVIEW_LINES;
  const lines = raw.split("\n");
  const shown = lines.slice(0, maxLines).map((line) => styleFindLine(line, theme));
  if (lines.length > maxLines) shown.push(theme.fg("muted", `... ${lines.length - maxLines} more find lines (${expandHint()})`));
  return reuseText(context, shown.join("\n"));
}

export function regFind(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "find",
    label: "Find",
    description: loadP("../prompts/find.md"),
    promptSnippet: loadP("../prompts/find-snippet.md"),
    promptGuidelines: loadGuide("../prompts/find-guidelines.md"),
    prepareArguments: makePrepareArguments(),
    parameters: findToolSchema,
    executionMode: "sequential",
    renderCall(args: any, theme: CallT, context: any) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(fmtFindCall(args as { pattern?: unknown; path?: unknown; limit?: unknown } | undefined, theme));
      return text;
    },
    renderResult(result, opts, theme, context) {
      return renderFindResult(result as never, opts as { isPartial: boolean; expanded?: boolean }, theme as never, context as never);
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const canonical = normReq(params);
      assertFindReq(canonical);
      const req = canonical;
      const limit = req.limit ?? DEFAULT_LIMIT;
      const base = req.path ? toCwd(req.path, ctx.cwd) : ctx.cwd;
      if (signal?.aborted) throw new Error("Operation aborted");

      let baseStat;
      try {
        baseStat = await stat(base);
      } catch (error) {
        if (errCode(error) === "ENOENT") {
          throw new Error(`[E_NOT_FOUND] File not found: ${req.path ?? ctx.cwd}`);
        }
        throw new Error(`[E_ACCESS] Cannot access path: ${req.path ?? ctx.cwd}`);
      }

      const globRoot = baseStat.isFile() ? dirname(base) : base;
      const globRegex = globToRegex(req.pattern);
      const matchesGlob = (absPath: string): boolean => {
        const displayPath = toDisplayPath(ctx.cwd, absPath);
        const globPath = toDisplayPath(globRoot, absPath);
        return globRegex.test(globPath) || globRegex.test(displayPath);
      };

      const rgPath = await resolveRgPath();
      const candidates = baseStat.isFile() ? [base] : await collectRgFiles(rgPath, base, signal);
      const matches = candidates
        .map((entry) => (baseStat.isFile() ? entry : toCwd(entry, base)))
        .filter((absPath) => matchesGlob(absPath))
        .map((absPath) => toDisplayPath(ctx.cwd, absPath))
        .sort(cmp);

      const limitReached = matches.length > limit;
      const selected = matches.slice(0, limit);

      const notices: string[] = [];
      if (limitReached) notices.push(`[find: showing first ${limit} results; increase limit to see more.]`);

      let text: string;
      let truncation: TruncationResult | undefined;
      if (selected.length === 0) {
        text = "No files found matching pattern.";
      } else {
        const rawOutput = selected.join("\n");
        const totalBytes = Buffer.byteLength(rawOutput, "utf-8");
        const head = selected.slice(0, DEFAULT_MAX_LINES).join("\n");
        const clipped = Buffer.byteLength(head, "utf-8") > DEFAULT_MAX_BYTES
          ? Buffer.from(head, "utf-8").subarray(0, DEFAULT_MAX_BYTES).toString("utf-8")
          : head;
        if (clipped !== rawOutput) {
          const outputLines = clipped === "" ? 0 : clipped.split("\n").length;
          truncation = {
            content: clipped,
            truncated: true,
            truncatedBy: Buffer.byteLength(head, "utf-8") > DEFAULT_MAX_BYTES ? "bytes" : "lines",
            totalLines: selected.length,
            totalBytes,
            outputLines,
            outputBytes: Buffer.byteLength(clipped, "utf-8"),
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          };
          notices.push(`[find: output truncated at ${DEFAULT_MAX_LINES} rows or ${formatSize(DEFAULT_MAX_BYTES)}; refine the pattern or narrow path.]`);
        }
        text = clipped;
      }
      if (notices.length > 0) text += `\n\n${notices.join("\n")}`;

      return {
        content: [{ type: "text", text }],
        details: {
          ...(truncation ? { truncation } : {}),
          metrics: {
            files: selected.length,
            truncated: limitReached || truncation !== undefined,
          },
        },
      };
    },
  });
}
