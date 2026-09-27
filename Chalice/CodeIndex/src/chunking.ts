import Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { CodeChunk, ResolvedConfig, SourceFile } from "./types.ts";

// This extension is vendored under Chalice rather than installed as its own package. Resolve the
// grammar assets through Node's module resolver so they work from both the source tree and a
// packaged installation, regardless of the extension's location.
const wasmDir = join(dirname(createRequire(import.meta.url).resolve("tree-sitter-wasms/package.json")), "out");

let parserReady: Promise<void> | undefined;
const languages = new Map<string, any>();

const GRAMMAR_BY_LANGUAGE: Record<string, string> = {
	typescript: "tree-sitter-typescript.wasm",
	tsx: "tree-sitter-tsx.wasm",
	javascript: "tree-sitter-javascript.wasm",
	jsx: "tree-sitter-javascript.wasm",
	python: "tree-sitter-python.wasm",
	rust: "tree-sitter-rust.wasm",
	go: "tree-sitter-go.wasm",
	java: "tree-sitter-java.wasm",
};

// Leaf declarations become a chunk on their own; we prune (do not descend) once matched so
// nested members are never double-covered by an enclosing node.
const LEAF_NODE_TYPES = new Set([
	"function_declaration",
	"function_definition",
	"method_definition",
	"method_declaration",
	"function_item",
	"lexical_declaration",
	"variable_declaration",
]);

// Containers are descended into so their members chunk at method granularity; an empty container
// (e.g. an interface or a struct with no methods) is emitted whole as a fallback.
const CONTAINER_NODE_TYPES = new Set([
	"class_declaration",
	"class_definition",
	"impl_item",
	"trait_item",
	"interface_declaration",
	"struct_item",
	"enum_item",
]);

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function sliceLines(lines: string[], startLine: number, endLine: number): string {
	return lines.slice(startLine - 1, endLine).join("\n");
}

// Keep requests below common embedding-provider limits. Code can tokenize much more densely than
// prose, so this conservative character cap prevents an individual chunk from exceeding an 8K-token
// provider limit (including the metadata prefix). Oversized lines are split as well.
const MAX_EMBEDDED_CONTENT_CHARS = 6000;

function makeSafeChunks(source: SourceFile, projectRoot: string, startLine: number, endLine: number, content: string, symbol: string | undefined, prefixContext?: string): CodeChunk[] {
	const limit = Math.max(1000, MAX_EMBEDDED_CONTENT_CHARS - (prefixContext?.length ?? 0));
	if (content.length <= limit) return [makeChunk(source, projectRoot, startLine, endLine, content, symbol, prefixContext)];

	const chunks: CodeChunk[] = [];
	let offset = 0;
	let chunkStartLine = startLine;
	while (offset < content.length) {
		let end = Math.min(content.length, offset + limit);
		if (end < content.length) {
			const newline = content.lastIndexOf("\n", end);
			if (newline > offset) end = newline;
		}
		const piece = content.slice(offset, end);
		if (piece.trim()) {
			const linesInPiece = piece.match(/\n/g)?.length ?? 0;
			const chunkEndLine = Math.min(endLine, chunkStartLine + linesInPiece);
			chunks.push(makeChunk(source, projectRoot, chunkStartLine, chunkEndLine, piece, symbol, prefixContext));
			chunkStartLine = chunkEndLine + (end < content.length && content[end] === "\n" ? 1 : 0);
		}
		offset = end < content.length && content[end] === "\n" ? end + 1 : end;
	}
	return chunks;
}
function makeChunk(source: SourceFile, projectRoot: string, startLine: number, endLine: number, content: string, symbol: string | undefined, prefixContext?: string): CodeChunk {
	// embeddedText omits line numbers so the contentHash is stable under line drift, letting the
	// incremental indexer reuse an unchanged chunk's existing vector instead of re-embedding it.
	// prefixContext (an optional overlap tail of the preceding chunk) is folded into the EMBEDDED text
	// for cross-boundary recall but is NOT stored as content, so the agent-facing snippet and line
	// range stay exact. It does enter contentHash, so overlap reduces incremental-reuse hit rate.
	const embedBody = prefixContext ? `${prefixContext}\n${content}` : content;
	const embeddedText = `File: ${source.path}\nLanguage: ${source.language}\n${symbol ? `Symbol: ${symbol}\n` : ""}Code:\n${embedBody}`;
	const contentHash = sha(embeddedText);
	const id = sha(`${projectRoot}:${source.path}:${startLine}:${contentHash}`).slice(0, 32);
	return {
		id,
		projectRoot,
		path: source.path,
		language: source.language,
		symbol,
		startLine,
		endLine,
		content,
		embeddedText,
		contentHash,
		fileHash: source.fileHash,
		mtimeMs: source.mtimeMs,
		size: source.size,
	};
}

function windowRange(source: SourceFile, projectRoot: string, config: ResolvedConfig, fromLine: number, toLine: number, lines: string[], symbol: string | undefined): CodeChunk[] {
	const chunks: CodeChunk[] = [];
	const size = Math.max(1, config.chunkLines);
	const overlap = Math.max(0, Math.min(config.chunkOverlap, size - 1));
	let start = fromLine;
	while (start <= toLine) {
		const end = Math.min(toLine, start + size - 1);
		const content = sliceLines(lines, start, end);
		if (content.trim()) chunks.push(...makeSafeChunks(source, projectRoot, start, end, content, symbol));
		if (end === toLine) break;
		start = end - overlap + 1;
	}
	return chunks;
}

async function ensureParserReady(): Promise<void> {
	if (!parserReady) parserReady = Parser.init();
	await parserReady;
}

async function loadLanguage(language: string): Promise<any | undefined> {
	const grammar = GRAMMAR_BY_LANGUAGE[language];
	if (!grammar) return undefined;
	if (languages.has(language)) return languages.get(language);
	await ensureParserReady();
	try {
		const lang = await Parser.Language.load(join(wasmDir, grammar));
		languages.set(language, lang);
		return lang;
	} catch {
		return undefined;
	}
}

function getNodeName(node: any): string | undefined {
	try {
		const named = node.childForFieldName?.("name");
		if (named?.text) return named.text;
	} catch {}
	for (const child of node.namedChildren ?? []) {
		if (child.type === "identifier" || child.type === "property_identifier" || child.type === "type_identifier") return child.text;
	}
	return undefined;
}

function nearestClassName(node: any): string | undefined {
	let cur = node.parent;
	while (cur) {
		if (cur.type === "class_declaration" || cur.type === "class_definition") return getNodeName(cur);
		cur = cur.parent;
	}
	return undefined;
}

function symbolFor(node: any): string | undefined {
	const name = getNodeName(node);
	if (!name) return undefined;
	const cls = nearestClassName(node);
	if (cls && !["class_declaration", "class_definition"].includes(node.type)) return `${cls} > ${name}`;
	return name;
}

// Single top-down pass: emit leaf declarations (pruning their subtree) and descend into containers
// so members chunk individually. No node is collected twice, so chunks never overlap.
function collectChunkNodes(root: any): any[] {
	const out: any[] = [];
	function visit(node: any): boolean {
		if (LEAF_NODE_TYPES.has(node.type)) {
			out.push(node);
			return true;
		}
		if (CONTAINER_NODE_TYPES.has(node.type)) {
			let covered = false;
			for (const child of node.namedChildren ?? []) covered = visit(child) || covered;
			if (!covered) out.push(node);
			return true;
		}
		let covered = false;
		for (const child of node.namedChildren ?? []) covered = visit(child) || covered;
		return covered;
	}
	visit(root);
	return out
		.filter((n) => n.endPosition.row > n.startPosition.row || String(n.text ?? "").length > 80)
		.sort((a, b) => a.startIndex - b.startIndex);
}

// Cover the lines that no AST chunk claimed (imports, top-level statements, code between members)
// with line-window chunks so they are still searchable.
function gapChunks(source: SourceFile, projectRoot: string, config: ResolvedConfig, lines: string[], covered: Set<number>): CodeChunk[] {
	const chunks: CodeChunk[] = [];
	const pushGap = (from: number, to: number): void => {
		const seg = sliceLines(lines, from, to);
		if (seg.trim() && /[A-Za-z0-9_]/.test(seg)) chunks.push(...windowRange(source, projectRoot, config, from, to, lines, undefined));
	};
	let start = -1;
	for (let ln = 1; ln <= lines.length; ln++) {
		const isCovered = covered.has(ln);
		if (!isCovered && start === -1) start = ln;
		if (isCovered && start !== -1) {
			pushGap(start, ln - 1);
			start = -1;
		}
	}
	if (start !== -1) pushGap(start, lines.length);
	return chunks;
}

// Sub-split a large AST node along its body's STATEMENT boundaries (not raw line windows), so each
// sub-chunk is a coherent slice with focused semantics instead of one diluted whole-function vector.
// The first sub-chunk keeps the signature line(s); all sub-chunks carry the parent symbol.
function subSplitNode(node: any, source: SourceFile, projectRoot: string, config: ResolvedConfig, lines: string[], symbol: string | undefined): CodeChunk[] {
	const nodeStart = node.startPosition.row + 1;
	const nodeEnd = node.endPosition.row + 1;
	const body = node.childForFieldName?.("body") ?? node;
	const stmts = (body.namedChildren ?? []).filter((c: any) => c.endPosition.row > c.startPosition.row || String(c.text ?? "").length > 40);
	if (stmts.length <= 1) return windowRange(source, projectRoot, config, nodeStart, nodeEnd, lines, symbol);
	const chunks: CodeChunk[] = [];
	let groupStart = nodeStart; // first sub-chunk includes the signature line(s)
	let curEnd = nodeStart - 1;
	let groupChars = 0;
	const flush = (nextStart: number): void => {
		const content = sliceLines(lines, groupStart, curEnd);
		if (content.trim()) chunks.push(...makeSafeChunks(source, projectRoot, groupStart, curEnd, content, symbol));
		groupStart = nextStart;
		groupChars = 0;
	};
	for (const st of stmts) {
		const stChars = String(st.text ?? "").length;
		if (groupChars > 0 && groupChars + stChars > config.maxChunkChars) flush(st.startPosition.row + 1);
		curEnd = st.endPosition.row + 1;
		groupChars += stChars;
	}
	const tail = sliceLines(lines, groupStart, curEnd);
	if (tail.trim()) chunks.push(...makeSafeChunks(source, projectRoot, groupStart, curEnd, tail, symbol));
	return chunks.length ? chunks : windowRange(source, projectRoot, config, nodeStart, nodeEnd, lines, symbol);
}

// Fold a tail slice of each chunk's predecessor into its embedded text (claude-context's addOverlap
// idea) to give the embedding cross-boundary context. Unlike claude-context we keep the returned
// content + line range exact — the overlap rides only in embeddedText. Overlap never crosses files
// (chunks are per-file here). Off (chunkOverlapChars=0) by default; flip it and reindex to A/B test.
function applyOverlap(chunks: CodeChunk[], source: SourceFile, projectRoot: string, config: ResolvedConfig): CodeChunk[] {
	const n = Math.max(0, config.chunkOverlapChars ?? 0);
	if (n <= 0 || chunks.length <= 1) return chunks;
	const out: CodeChunk[] = [chunks[0]];
	for (let i = 1; i < chunks.length; i++) {
		const prevTail = chunks[i - 1].content.slice(-n).trim();
		const cur = chunks[i];
		if (prevTail) out.push(...makeSafeChunks(source, projectRoot, cur.startLine, cur.endLine, cur.content, cur.symbol, prevTail));
	}
	return out;
}

export async function chunkSourceFile(source: SourceFile, projectRoot: string, config: ResolvedConfig): Promise<CodeChunk[]> {
	const lines = source.content.split(/\r?\n/);
	const lang = await loadLanguage(source.language);
	if (!lang) return windowRange(source, projectRoot, config, 1, lines.length, lines, undefined);
	try {
		const parser = new Parser();
		parser.setLanguage(lang);
		const tree = parser.parse(source.content);
		const nodes = collectChunkNodes(tree.rootNode);
		if (nodes.length === 0) return windowRange(source, projectRoot, config, 1, lines.length, lines, undefined);
		const chunks: CodeChunk[] = [];
		const covered = new Set<number>();
		for (const node of nodes) {
			const startLine = node.startPosition.row + 1;
			const endLine = node.endPosition.row + 1;
			for (let ln = startLine; ln <= endLine; ln++) covered.add(ln);
			const content = sliceLines(lines, startLine, endLine);
			if (!content.trim()) continue;
			const symbol = symbolFor(node);
			if (content.length > config.maxChunkChars) chunks.push(...subSplitNode(node, source, projectRoot, config, lines, symbol));
			else chunks.push(...makeSafeChunks(source, projectRoot, startLine, endLine, content, symbol));
		}
		chunks.push(...gapChunks(source, projectRoot, config, lines, covered));
		if (chunks.length === 0) return windowRange(source, projectRoot, config, 1, lines.length, lines, undefined);
		return applyOverlap(chunks.sort((a, b) => a.startLine - b.startLine), source, projectRoot, config);
	} catch {
		return windowRange(source, projectRoot, config, 1, lines.length, lines, undefined);
	}
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export async function estimateChunksForFile(source: SourceFile, projectRoot: string, config: ResolvedConfig): Promise<{ chunks: CodeChunk[]; tokens: number }> {
	const chunks = await chunkSourceFile(source, projectRoot, config);
	return { chunks, tokens: chunks.reduce((sum, c) => sum + estimateTokens(c.embeddedText), 0) };
}
