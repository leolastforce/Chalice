/**
 * Digests for oversized tool output.
 *
 * Plain head or tail truncation drops whatever falls outside the kept window. For a 20k-line test
 * run that means the first failure (often the root cause) disappears while the model sees thousands
 * of passing-test lines. A digest keeps three parts instead:
 * - the first lines (command banner, configuration, first errors),
 * - "notable" lines from the omitted middle (errors, failures, warnings, test summaries),
 * - the last lines (final errors, exit summaries).
 * The full output is written to a file so the agent can page through it with read/grep.
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateTail } from "./truncate.ts";

/** Head budget for shell output: errors usually sit at the end, so the head stays small. */
export const SHELL_DIGEST_HEAD_MAX_LINES = 50;
export const SHELL_DIGEST_HEAD_MAX_BYTES = 4 * 1024;
/** Maximum notable lines shown from the omitted middle section. */
export const NOTABLE_MAX_LINES = 40;
/** Notable lines are clipped to this many characters. */
export const NOTABLE_LINE_MAX_CHARS = 300;

/**
 * Generic tool results above these limits are digested by the session-level guard. The slack over
 * the per-tool defaults keeps tools that already truncate themselves (bash, read, grep, MCP) from
 * being processed twice because of their own truncation notices.
 */
export const TOOL_RESULT_GUARD_MAX_BYTES = DEFAULT_MAX_BYTES + 16 * 1024;
export const TOOL_RESULT_GUARD_MAX_LINES = DEFAULT_MAX_LINES + 200;

const NOTABLE_KEEP_FIRST = 20;
const NOTABLE_KEEP_LAST = 60;
/** Only this prefix of each line is scanned, so a multi-megabyte single line costs bounded memory. */
const NOTABLE_SCAN_PREFIX_CHARS = 2000;
/** Bytes reserved for the omitted-section marker and footer lines. */
const MARKER_RESERVE_BYTES = 512;

const NOTABLE_LINE_PATTERN =
	/\b(?:errors?|fail(?:s|ed|ure|ures|ing)?|fatal|panic(?:ked)?|exception|traceback|assert(?:ion)?(?:error)?|warn(?:ing)?s?|denied|cannot|unable to|not found|undefined reference|segmentation fault|timed out|aborted)\b|\bERR!|[✗✖✘]|\b\d+\s+(?:passed|failed|skipped|errors?|warnings?)\b/i;
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export interface NotableLine {
	/** 1-indexed line number in the full output. */
	line: number;
	/** Line text without ANSI escapes, clipped to NOTABLE_LINE_MAX_CHARS. */
	text: string;
}

export function isNotableLine(line: string): boolean {
	return NOTABLE_LINE_PATTERN.test(line);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function clipLine(line: string): string {
	const clean = line.trimEnd();
	return clean.length > NOTABLE_LINE_MAX_CHARS ? `${clean.slice(0, NOTABLE_LINE_MAX_CHARS)}...` : clean;
}

/**
 * Streaming scanner that records notable lines with their line numbers.
 *
 * Memory is bounded: it keeps the first NOTABLE_KEEP_FIRST and the last NOTABLE_KEEP_LAST matches,
 * plus a capped prefix of the line currently being received.
 */
export class NotableLineCollector {
	private lineNumber = 1;
	private current = "";
	private first: NotableLine[] = [];
	private last: NotableLine[] = [];
	private matched = 0;

	/** Feed decoded text. Chunks may split lines anywhere. */
	push(text: string): void {
		let start = 0;
		while (start <= text.length) {
			const newline = text.indexOf("\n", start);
			const end = newline === -1 ? text.length : newline;
			const room = NOTABLE_SCAN_PREFIX_CHARS - this.current.length;
			if (room > 0 && end > start) {
				this.current += text.slice(start, Math.min(end, start + room));
			}
			if (newline === -1) return;
			this.completeLine();
			start = newline + 1;
		}
	}

	/** Flush a final line that has no trailing newline. */
	finish(): void {
		if (this.current.length > 0) {
			this.completeLine();
		}
	}

	/** Total notable lines seen in the whole output (including ones no longer retained). */
	get total(): number {
		return this.matched;
	}

	/**
	 * Retained notable lines within [startLine, endLine], at most `max`, favoring the earliest and
	 * latest matches when there are too many.
	 */
	inRange(startLine: number, endLine: number, max: number = NOTABLE_MAX_LINES): NotableLine[] {
		if (endLine < startLine || max <= 0) return [];
		const matches = [...this.first, ...this.last].filter((n) => n.line >= startLine && n.line <= endLine);
		if (matches.length <= max) return matches;
		const fromStart = Math.ceil(max * 0.4);
		return [...matches.slice(0, fromStart), ...matches.slice(matches.length - (max - fromStart))];
	}

	private completeLine(): void {
		// Strip ANSI first: in "\x1b[31mFAIL" the color code would defeat the word boundary before FAIL.
		const line = (this.current.endsWith("\r") ? this.current.slice(0, -1) : this.current).replace(ANSI_PATTERN, "");
		if (isNotableLine(line)) {
			this.matched++;
			const entry = { line: this.lineNumber, text: clipLine(line) };
			if (this.first.length < NOTABLE_KEEP_FIRST) {
				this.first.push(entry);
			} else {
				this.last.push(entry);
				if (this.last.length > NOTABLE_KEEP_LAST) this.last.shift();
			}
		}
		this.lineNumber++;
		this.current = "";
	}
}

/** Format the marker that replaces an omitted line range, listing notable lines from it. */
export function formatOmittedSection(
	startLine: number,
	endLine: number,
	notable: readonly NotableLine[],
	notableTotal: number,
): string {
	const count = endLine - startLine + 1;
	let header = `... [${count} line${count === 1 ? "" : "s"} omitted (lines ${startLine}-${endLine})`;
	if (notable.length > 0) {
		header += `; ${notable.length} notable line${notable.length === 1 ? "" : "s"} from this range below (${notableTotal} in full output)`;
	}
	header += "]";
	if (notable.length === 0) return header;
	return [header, ...notable.map((n) => `  ${n.line}: ${n.text}`), "... [end of omitted range]"].join("\n");
}

export interface DigestParts {
	head: string;
	headLines: number;
	tail: string;
	tailStartLine: number;
	notable: readonly NotableLine[];
	notableTotal: number;
}

export function composeDigest(parts: DigestParts): string {
	const omitted = formatOmittedSection(
		parts.headLines + 1,
		parts.tailStartLine - 1,
		parts.notable,
		parts.notableTotal,
	);
	return [parts.head, omitted, parts.tail].filter((part) => part.length > 0).join("\n");
}

function notableBytes(notable: readonly NotableLine[]): number {
	let bytes = 0;
	for (const n of notable) bytes += byteLength(n.text) + 12;
	return bytes;
}

/** Plan head + notable + tail budgets. Shared by the streaming accumulator and the one-shot digest. */
export function planDigest(input: {
	/** Head text candidate (beginning of output, line aligned). */
	head: string;
	headMaxLines: number;
	headMaxBytes: number;
	/** Text whose end contains the output tail (may be a rolling window of the output). */
	tailSource: string;
	totalLines: number;
	maxLines: number;
	maxBytes: number;
	collector: NotableLineCollector;
}): (DigestParts & { tailLastLinePartial: boolean; tailOutputLines: number }) | undefined {
	const head = truncateHead(input.head, { maxLines: input.headMaxLines, maxBytes: input.headMaxBytes });
	const headLines = head.firstLineExceedsLimit ? 0 : head.outputLines;
	if (headLines === 0) return undefined;

	const candidates = input.collector.inRange(headLines + 1, input.totalLines);
	const tail = truncateTail(input.tailSource, {
		maxLines: Math.max(1, input.maxLines - headLines - candidates.length - 3),
		maxBytes: Math.max(1, input.maxBytes - head.outputBytes - notableBytes(candidates) - MARKER_RESERVE_BYTES),
	});
	const tailStartLine = input.totalLines - tail.outputLines + 1;
	if (tailStartLine <= headLines + 1) return undefined;

	return {
		head: head.content,
		headLines,
		tail: tail.content,
		tailStartLine,
		tailLastLinePartial: tail.lastLinePartial,
		tailOutputLines: tail.outputLines,
		notable: input.collector.inRange(headLines + 1, tailStartLine - 1),
		notableTotal: input.collector.total,
	};
}

function sliceToBytes(text: string, maxBytes: number, fromEnd: boolean): string {
	const buffer = Buffer.from(text, "utf-8");
	if (buffer.length <= maxBytes) return text;
	if (fromEnd) {
		let start = buffer.length - maxBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		return buffer.subarray(start).toString("utf-8");
	}
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf-8");
}

export interface TextDigest {
	content: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	/** Human-readable description of what is shown, e.g. "lines 1-120, 1900-2400 of 2400". */
	shown: string;
}

/**
 * One-shot digest for text that is already fully in memory. Keeps a larger head than shell output
 * because generic tool results (JSON, file listings, documents) are often most useful at the start.
 */
export function digestText(
	text: string,
	options: { maxLines?: number; maxBytes?: number; headRatio?: number } = {},
): TextDigest {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const headRatio = options.headRatio ?? 0.4;
	const totalBytes = byteLength(text);
	const lines = text.length === 0 ? [] : text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	const totalLines = lines.length;
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return { content: text, truncated: false, totalLines, totalBytes, shown: `all ${totalLines} lines` };
	}

	const collector = new NotableLineCollector();
	collector.push(text);
	collector.finish();
	const plan = planDigest({
		head: text,
		headMaxLines: Math.floor(maxLines * headRatio),
		headMaxBytes: Math.floor(maxBytes * headRatio),
		tailSource: text,
		totalLines,
		maxLines,
		maxBytes,
		collector,
	});
	if (plan) {
		const tailEnd = plan.tailLastLinePartial ? `${totalLines} (partial)` : `${totalLines}`;
		return {
			content: composeDigest(plan),
			truncated: true,
			totalLines,
			totalBytes,
			shown: `lines 1-${plan.headLines}, ${plan.tailStartLine}-${tailEnd} of ${totalLines}`,
		};
	}

	// Very long lines (minified JSON, base64) defeat line-based windows: keep raw byte ranges.
	const budget = Math.max(0, maxBytes - MARKER_RESERVE_BYTES);
	const headBytes = Math.floor(budget * headRatio);
	const head = sliceToBytes(text, headBytes, false);
	const tail = sliceToBytes(text, budget - byteLength(head), true);
	const omittedBytes = totalBytes - byteLength(head) - byteLength(tail);
	return {
		content: `${head}\n... [${formatSize(omittedBytes)} omitted] ...\n${tail}`,
		truncated: true,
		totalLines,
		totalBytes,
		shown: `first ${formatSize(byteLength(head))} and last ${formatSize(byteLength(tail))} of ${formatSize(totalBytes)}`,
	};
}

export interface ToolOutputGuardInfo {
	totalLines: number;
	totalBytes: number;
	fullOutputPath?: string;
	writeError?: string;
}

export interface GuardedToolContent {
	content: (TextContent | ImageContent)[];
	guard: ToolOutputGuardInfo;
}

/**
 * Cap oversized text in an arbitrary tool result. Returns undefined when the result is within
 * TOOL_RESULT_GUARD_MAX_BYTES / TOOL_RESULT_GUARD_MAX_LINES. Image blocks pass through unchanged.
 */
export async function guardToolResultContent(
	content: readonly (TextContent | ImageContent)[],
	options: { toolName: string; maxBytes?: number; maxLines?: number; tempDir?: string },
): Promise<GuardedToolContent | undefined> {
	const maxBytes = options.maxBytes ?? TOOL_RESULT_GUARD_MAX_BYTES;
	const maxLines = options.maxLines ?? TOOL_RESULT_GUARD_MAX_LINES;
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	if (textBlocks.length === 0) return undefined;
	const fullText = textBlocks.map((block) => block.text).join("\n");
	const bytes = byteLength(fullText);
	if (bytes <= maxBytes) {
		// Byte check first: counting lines is only needed when the text could exceed the line cap.
		let lines = 1;
		for (let i = fullText.indexOf("\n"); i !== -1 && lines <= maxLines; i = fullText.indexOf("\n", i + 1)) lines++;
		if (lines <= maxLines) return undefined;
	}

	const digest = digestText(fullText, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const guard: ToolOutputGuardInfo = { totalLines: digest.totalLines, totalBytes: digest.totalBytes };
	const safeName = options.toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "tool";
	const path = join(options.tempDir ?? tmpdir(), `pi-tool-output-${safeName}-${randomBytes(6).toString("hex")}.log`);
	try {
		await writeFile(path, fullText, { encoding: "utf-8", mode: 0o600 });
		guard.fullOutputPath = path;
	} catch (error) {
		guard.writeError = error instanceof Error ? error.message : String(error);
	}

	const where = guard.fullOutputPath
		? `Full output: ${guard.fullOutputPath} (use read with offset/limit, or grep, to inspect it)`
		: `Full output could not be saved: ${guard.writeError}`;
	const notice = `[Tool output truncated (${digest.totalLines} lines, ${formatSize(digest.totalBytes)}). Showing ${digest.shown}. ${where}]`;
	return {
		content: [{ type: "text", text: `${digest.content}\n\n${notice}` }, ...content.filter((b) => b.type === "image")],
		guard,
	};
}
