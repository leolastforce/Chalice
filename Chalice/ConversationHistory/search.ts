import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

export const HISTORY_MAX_RESULT_BYTES = 16_000;
export const HISTORY_MAX_RESULTS = 50;
export const HISTORY_MAX_SCAN_BYTES = 64 * 1024 * 1024;
export const HISTORY_MAX_SCAN_MS = 5_000;
export const HISTORY_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const HISTORY_MAX_LINE_BYTES = 1024 * 1024;

interface Header { type: "session"; version?: number; id: string; cwd: string; timestamp: string; parentSession?: string }
interface Entry { type: string; id?: string; parentId?: string | null; timestamp?: string; customType?: string; data?: unknown; targetId?: string; replacement?: null | { content?: unknown }; message?: { role?: string; content?: unknown; timestamp?: number } }
interface Source { root: string; path: string; header: Header; entries: Entry[]; bytes: number }
export interface HistoryReference { sessionId: string; cwd: string; entryIds: string[]; matchEntryId: string; scope: "project" | "all"; signature: string }
export interface HistoryOptions { roots: string[]; cwd: string; currentSessionId?: string; query: string; scope?: "project" | "all"; after?: string; before?: string; limit?: number; signal?: AbortSignal }
interface Passage { source: Source; entries: Entry[]; matchEntryId: string; score: number; timestamp: string; text: string }

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && item.type === "text" && typeof item.text === "string")).map((item) => item.text).join("\n");
}
function inRoot(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function parseLine(line: string): Entry | Header | undefined {
	try { const value: unknown = JSON.parse(line); return value && typeof value === "object" ? value as Entry | Header : undefined; } catch { return undefined; }
}
async function readSource(path: string, root: string, signal?: AbortSignal): Promise<Source | undefined> {
	try {
		signal?.throwIfAborted();
		const [rootReal, pathStat, pathReal] = await Promise.all([realpath(root), lstat(path), realpath(path)]);
		if (!pathStat.isFile() || pathStat.isSymbolicLink() || !inRoot(pathReal, rootReal)) return undefined;
		const fileStat = await stat(pathReal);
		if (fileStat.size > HISTORY_MAX_FILE_BYTES) return undefined;
		const entries: Entry[] = [];
		let header: Header | undefined;
		let readBytes = 0;
		const input = createReadStream(pathReal, { encoding: "utf8", signal });
		const lines = createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			signal?.throwIfAborted();
			readBytes += Buffer.byteLength(line, "utf8") + 1;
			if (readBytes > HISTORY_MAX_FILE_BYTES || Buffer.byteLength(line, "utf8") > HISTORY_MAX_LINE_BYTES) return undefined;
			const value = parseLine(line);
			if (!value) {
				if (line.trim()) return undefined;
				continue;
			}
			if (!header) {
				const candidate = value as Header;
				if (value.type !== "session" || typeof candidate.id !== "string" || typeof candidate.cwd !== "string" || (candidate.version !== undefined && (!Number.isInteger(candidate.version) || candidate.version < 1 || candidate.version > 3))) return undefined;
				header = value as Header;
			} else entries.push(value as Entry);
		}
		if (!header) return undefined;
		if ((header.version ?? 1) < 2) {
			let parentId: string | null = null;
			entries.forEach((entry, index) => {
				entry.id = `legacy-${index}`;
				entry.parentId = parentId;
				parentId = entry.id;
			});
		}
		return { root: rootReal, path: pathReal, header, entries, bytes: fileStat.size };
	} catch (error) {
		if (signal?.aborted) throw error;
		return undefined;
	}
}
async function discover(roots: string[], signal?: AbortSignal, deadline?: number): Promise<{ files: { path: string; root: string }[]; complete: boolean }> {
	const files: { path: string; root: string; modified: number }[] = [];
	let complete = true;
	for (const candidate of [...new Set(roots.map((root) => resolve(root)))]) {
		signal?.throwIfAborted();
		if (deadline !== undefined && Date.now() > deadline) { complete = false; break; }
		let root: string;
		try { const info = await lstat(candidate); if (!info.isDirectory() || info.isSymbolicLink()) continue; root = await realpath(candidate); } catch { continue; }
		const dirs = await readdir(root, { withFileTypes: true }).then((items) => items.filter((item) => item.isDirectory() && !item.isSymbolicLink()).map((item) => join(root, item.name))).catch(() => []);
		for (const dir of [root, ...dirs]) {
			if (!complete || (deadline !== undefined && Date.now() > deadline)) { complete = false; break; }
			const names = await readdir(dir).catch(() => []);
			for (const name of names) {
				if (deadline !== undefined && Date.now() > deadline || files.length >= 10_000) { complete = false; break; }
				if (!name.endsWith(".jsonl")) continue;
				const path = join(dir, name);
				try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) continue; files.push({ path, root, modified: info.mtimeMs }); } catch { /* deleted during discovery */ }
			}
		}
		if (!complete) break;
	}
	const seenPaths = new Set<string>();
	const uniqueFiles = files.filter(({ path }) => {
		const key = resolve(path);
		if (seenPaths.has(key)) return false;
		seenPaths.add(key);
		return true;
	});
	return { files: uniqueFiles.sort((a, b) => b.modified - a.modified).map(({ path, root }) => ({ path, root })), complete };
}
function onLatestPath(source: Source): Entry[] {
	const byId = new Map<string, Entry>();
	for (const entry of source.entries) {
		if (!entry.id || byId.has(entry.id)) return [];
		byId.set(entry.id, entry);
	}
	let cursor = source.entries.at(-1);
	const path: Entry[] = [];
	const seen = new Set<string>();
	while (cursor) {
		if (!cursor.id || seen.has(cursor.id)) return [];
		seen.add(cursor.id);
		path.push(cursor);
		if (cursor.parentId) {
			const parent = byId.get(cursor.parentId);
			if (!parent) return [];
			cursor = parent;
		} else cursor = undefined;
	}
	return path.reverse();
}
function privateSession(source: Source): boolean {
	return source.entries.some((entry) => entry.type === "custom" && entry.customType === "chalice-memory-private" && entry.data === true);
}
function visibleMessages(source: Source): Entry[] {
	const allEdits = new Map<string, Entry>();
	for (const entry of source.entries) if (entry.type === "context_edit" && entry.targetId) allEdits.set(entry.targetId, entry);
	const path = onLatestPath(source);
	const messages: Entry[] = [];
	for (const entry of path) {
		if (entry.type !== "message" || (entry.message?.role !== "user" && entry.message?.role !== "assistant")) continue;
		const edit = entry.id ? allEdits.get(entry.id) : undefined;
		if (edit?.replacement === null) continue;
		if (edit?.replacement && typeof edit.replacement === "object" && "content" in edit.replacement) {
			messages.push({ ...entry, message: { ...entry.message, content: edit.replacement.content } });
		} else if (!edit) messages.push(entry);
	}
	return messages;
}
function matchScore(text: string, query: string): number {
	const { tokens, phrases } = queryParts(query);
	const normalized = text.toLocaleLowerCase();
	const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
	const wordSet = new Set(words);
	const found = tokens.filter((token) => wordSet.has(token));
	if (!found.length && !phrases.some((phrase) => normalized.includes(phrase))) return 0;
	const coverage = tokens.length ? found.length / new Set(tokens).size : 1;
	const phrase = phrases.filter((item) => normalized.includes(item)).length * 3;
	const positions = found.map((token) => normalized.indexOf(token)).sort((a, b) => a - b);
	const density = positions.length > 1 ? 1 / (1 + (positions.at(-1)! - positions[0]!) / 200) : 1;
	return coverage * 10 + phrase + density;
	}

function queryParts(query: string): { tokens: string[]; phrases: string[] } {
	const phrases = Array.from(query.matchAll(/"([^"]+)"/gu), (match) => match[1]!.toLocaleLowerCase().trim()).filter(Boolean);
	const unquoted = query.replace(/"[^"]+"/gu, " ");
	return { tokens: unquoted.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [], phrases };
	}
function makePassages(source: Source, query: string, after?: number, before?: number): Passage[] {
	const messages = visibleMessages(source);
	const out: Passage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const entry = messages[i]!;
		const date = typeof entry.message?.timestamp === "number" && Number.isFinite(entry.message.timestamp) ? new Date(entry.message.timestamp).toISOString() : entry.timestamp ?? source.header.timestamp;
		const time = Date.parse(date);
		if ((after !== undefined && time < after) || (before !== undefined && time >= before)) continue;
		const context = messages.slice(Math.max(0, i - 1), Math.min(messages.length, i + 2));
		const body = context.map((item) => `${item.message?.role}: ${textOf(item.message?.content)}`).join("\n");
		const score = matchScore(textOf(entry.message?.content), query);
		if (score && entry.id) out.push({ source, entries: context, matchEntryId: entry.id, score, timestamp: date, text: body });
	}
	return out;
	}

function referenceSignature(source: Source, entryIds: string[]): string {
	const wanted = new Set(entryIds);
	const messages = visibleMessages(source).filter((entry) => entry.id && wanted.has(entry.id)).map((entry) => ({ id: entry.id, role: entry.message?.role, timestamp: entry.timestamp, text: textOf(entry.message?.content) }));
	return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
	}
function referenceFor(passage: Passage, scope: "project" | "all"): HistoryReference {
	const entryIds = passage.entries.flatMap((entry) => entry.id ? [entry.id] : []);
	return { sessionId: passage.source.header.id, cwd: resolve(passage.source.header.cwd), entryIds, matchEntryId: passage.matchEntryId, scope, signature: referenceSignature(passage.source, entryIds) };
}
function passageResult(passage: Passage, scope: "project" | "all") {
	const title = visibleMessages(passage.source).find((entry) => entry.message?.role === "user");
	const messages = passage.entries.map((entry) => {
		const text = textOf(entry.message?.content);
		return { entry: entry.id, role: entry.message?.role, date: entry.timestamp, text: text.slice(0, 600), clipped: text.length > 600 };
	});
	return { reference: referenceFor(passage, scope), session: passage.source.header.id, title: title ? textOf(title.message?.content).slice(0, 160) : "Untitled conversation", cwd: passage.source.header.cwd, date: passage.timestamp, messages, clipped: messages.some((message) => message.clipped) };
}
export async function searchHistory(options: HistoryOptions): Promise<string> {
	const query = options.query.trim();
	if (!query) throw new Error("query must not be empty");
	const start = Date.now();
	const cutoff = Date.now() + HISTORY_MAX_SCAN_MS;
	const discovery = await discover(options.roots, options.signal, cutoff);
	const files = discovery.files;
	const hits: Passage[] = [];
	let scanned = 0;
	let skipped = 0;
	let bytes = 0;
	let complete = discovery.complete;
	let incompleteReason: "scan_time_limit" | "scan_byte_limit" | undefined = complete ? undefined : Date.now() > cutoff ? "scan_time_limit" : "scan_byte_limit";
	for (const file of files) {
		options.signal?.throwIfAborted();
		if (Date.now() > cutoff || bytes >= HISTORY_MAX_SCAN_BYTES) {
			complete = false;
			incompleteReason = Date.now() > cutoff ? "scan_time_limit" : "scan_byte_limit";
			break;
		}
		const source = await readSource(file.path, file.root, options.signal);
		if (!source) { skipped++; continue; }
		bytes += source.bytes;
		scanned++;
		if (!source.header.cwd || source.header.id === options.currentSessionId || source.header.parentSession || privateSession(source)) continue;
		if (options.scope !== "all" && resolve(source.header.cwd) !== resolve(options.cwd)) continue;
		hits.push(...makePassages(source, query, options.after ? Date.parse(options.after) : undefined, options.before ? Date.parse(options.before) : undefined));
	}
	if (Date.now() > cutoff) { complete = false; incompleteReason = "scan_time_limit"; }
	else if (bytes >= HISTORY_MAX_SCAN_BYTES || files.length > scanned + skipped) { complete = false; incompleteReason = "scan_byte_limit"; }
	hits.sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp) || a.source.header.id.localeCompare(b.source.header.id));
	const distinct: Passage[] = [];
	const usedEntries = new Set<string>();
	const usedExchanges = new Set<string>();
	for (const hit of hits) {
		const ids = hit.entries.flatMap((entry) => entry.id ? [`${hit.source.header.id}:${entry.id}`] : []);
		const exchange = hit.text.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
		if (ids.some((id) => usedEntries.has(id)) || usedExchanges.has(exchange)) continue;
		ids.forEach((id) => usedEntries.add(id));
		usedExchanges.add(exchange);
		distinct.push(hit);
	}
	const limit = Math.max(1, Math.min(options.limit ?? 5, HISTORY_MAX_RESULTS));
	const result: { complete: boolean; reason?: string; scanned: number; skipped: number; elapsedMs: number; hits: object[]; truncated: boolean } = { complete, reason: incompleteReason, scanned, skipped, elapsedMs: Date.now() - start, hits: [], truncated: distinct.length > limit };
	for (const hit of distinct.slice(0, limit)) {
		const value = passageResult(hit, options.scope ?? "project");
		if (value.clipped) result.truncated = true;
		const candidate = { ...result, hits: [...result.hits, value] };
		if (Buffer.byteLength(JSON.stringify(candidate)) > HISTORY_MAX_RESULT_BYTES) { result.truncated = true; break; }
		result.hits.push(value);
	}
	return JSON.stringify(result);
}
export async function readHistoryReference(options: Omit<HistoryOptions, "query" | "after" | "before" | "limit"> & { reference: HistoryReference }): Promise<string> {
	const ref = options.reference;
	if (!ref || typeof ref.sessionId !== "string" || typeof ref.matchEntryId !== "string" || typeof ref.signature !== "string" || !Array.isArray(ref.entryIds) || !["project", "all"].includes(ref.scope)) throw new Error("Invalid history reference");
	const cutoff = Date.now() + HISTORY_MAX_SCAN_MS;
	const discovery = await discover(options.roots, options.signal, cutoff);
	if (!discovery.complete) return JSON.stringify({ error: "Reference validation exceeded scan limits; search again.", complete: false });
	const files = discovery.files;
	let bytes = 0;
	const matches: Source[] = [];
	for (const file of files) {
		options.signal?.throwIfAborted();
		if (Date.now() > cutoff || bytes >= HISTORY_MAX_SCAN_BYTES) return JSON.stringify({ error: "Reference validation exceeded scan limits; search again.", complete: false });
		const source = await readSource(file.path, file.root, options.signal);
		if (!source) continue;
		bytes += source.bytes;
		if (bytes > HISTORY_MAX_SCAN_BYTES) return JSON.stringify({ error: "Reference validation exceeded scan limits; search again.", complete: false });
		if (source.header.id === ref.sessionId && resolve(source.header.cwd) === resolve(ref.cwd)) matches.push(source);
	}
	if (matches.length !== 1) return JSON.stringify({ error: "History source is unavailable or ambiguous; search again." });
	const source = matches[0]!;
	if (!source.header.cwd || source.header.id === options.currentSessionId || source.header.parentSession || privateSession(source) || (options.scope !== "all" && resolve(source.header.cwd) !== resolve(options.cwd)) || (ref.scope === "all" && options.scope !== "all")) return JSON.stringify({ error: "History source is no longer available in this scope." });
	const visible = visibleMessages(source);
	if (referenceSignature(source, ref.entryIds) !== ref.signature) return JSON.stringify({ error: "History changed since search; search again." });
	const center = visible.findIndex((entry) => entry.id === ref.matchEntryId);
	if (center < 0) return JSON.stringify({ error: "History changed since search; search again." });
	const excerpt = visible.slice(Math.max(0, center - 2), Math.min(visible.length, center + 3));
	const messages = excerpt.map((entry) => ({ entry: entry.id, role: entry.message?.role, date: entry.timestamp, text: textOf(entry.message?.content) }));
	const result: { session: string; cwd: string; messages: typeof messages; clipped: boolean } = { session: source.header.id, cwd: source.header.cwd, messages: [], clipped: false };
	for (const message of messages) {
		const candidate = { ...result, messages: [...result.messages, message] };
		if (Buffer.byteLength(JSON.stringify(candidate)) <= HISTORY_MAX_RESULT_BYTES) { result.messages.push(message); continue; }
		const characters = Array.from(message.text);
		let low = 0; let high = characters.length;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			const clipped = { ...message, text: `${characters.slice(0, middle).join("")}…` };
			if (Buffer.byteLength(JSON.stringify({ ...result, messages: [...result.messages, clipped], clipped: true })) <= HISTORY_MAX_RESULT_BYTES) low = middle; else high = middle - 1;
		}
		if (low > 0) result.messages.push({ ...message, text: `${characters.slice(0, low).join("")}…` });
		result.clipped = true;
		break;
	}
	return JSON.stringify(result);
}
