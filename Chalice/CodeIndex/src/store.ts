import * as lancedb from "@lancedb/lancedb";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeChunk, Manifest, ManifestFileEntry, ProjectInfo, ResolvedConfig } from "./types.ts";
import { INDEX_VERSION } from "./types.ts";
import { DEFAULT_CONFIG, INDEX_AFFECTING_KEYS } from "./config.ts";

const TABLE_NAME = "chunks";

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function writeJson(path: string, data: unknown): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `${JSON.stringify(data, null, "\t")}\n`, "utf8");
}

export async function loadManifest(project: ProjectInfo): Promise<Manifest | undefined> {
	return readJson<Manifest>(project.manifestPath);
}

export async function saveManifest(project: ProjectInfo, manifest: Manifest): Promise<void> {
	manifest.updatedAt = new Date().toISOString();
	manifest.fileCount = Object.keys(manifest.files).length;
	manifest.chunkCount = Object.values(manifest.files).reduce((sum, f) => sum + f.chunkIds.length, 0);
	await writeJson(project.manifestPath, manifest);
}

export function newManifest(project: ProjectInfo, config: ResolvedConfig, dimension: number): Manifest {
	const now = new Date().toISOString();
	return {
		version: INDEX_VERSION,
		projectRoot: project.root,
		baseUrl: config.baseUrl,
		model: config.model,
		embeddingDim: dimension,
		indexParams: Object.fromEntries(INDEX_AFFECTING_KEYS.map((k) => [k, config[k]])),
		createdAt: now,
		updatedAt: now,
		chunkCount: 0,
		fileCount: 0,
		annIndexBuilt: false,
		files: {},
	};
}

export function manifestCompatible(manifest: Manifest | undefined, config: ResolvedConfig): { ok: boolean; reason?: string } {
	if (!manifest) return { ok: false, reason: "not indexed" };
	if (manifest.version !== INDEX_VERSION) return { ok: false, reason: `index schema version ${manifest.version} is stale` };
	if (manifest.model !== config.model || manifest.baseUrl !== config.baseUrl) return { ok: false, reason: `index model/provider is stale (${manifest.model})` };
	if (config.embeddingDim && manifest.embeddingDim !== config.embeddingDim) return { ok: false, reason: `index dimension ${manifest.embeddingDim} is stale` };
	// Chunking/file-scope params change the stored vectors without touching the embedding model, so
	// they get their own staleness gate — driven by the SAME INDEX_AFFECTING_KEYS the settings UI uses
	// to prompt reindex (single source of truth, so the two sets can't drift). Old manifests predate
	// indexParams → fall back to DEFAULT_CONFIG so an existing index isn't flagged while config matches.
	for (const k of INDEX_AFFECTING_KEYS) {
		if ((manifest.indexParams?.[k] ?? DEFAULT_CONFIG[k]) !== config[k]) return { ok: false, reason: `index chunking config (${k}) is stale, run /index reindex` };
	}
	return { ok: true };
}

async function db(project: ProjectInfo) {
	await mkdir(join(project.indexDir, "lancedb"), { recursive: true });
	return lancedb.connect(join(project.indexDir, "lancedb"));
}

async function tableExists(project: ProjectInfo): Promise<boolean> {
	const conn = await db(project);
	return (await conn.tableNames()).includes(TABLE_NAME);
}

export async function clearIndex(project: ProjectInfo): Promise<void> {
	await rm(project.indexDir, { recursive: true, force: true });
	await mkdir(project.indexDir, { recursive: true });
}

function escapeSql(value: string): string {
	return value.replaceAll("'", "''");
}

function rowFromChunk(chunk: CodeChunk & { vector: number[] }) {
	return {
		id: chunk.id,
		projectRoot: chunk.projectRoot,
		path: chunk.path,
		language: chunk.language,
		symbol: chunk.symbol ?? "",
		startLine: chunk.startLine,
		endLine: chunk.endLine,
		content: chunk.content,
		embeddedText: chunk.embeddedText,
		contentHash: chunk.contentHash,
		fileHash: chunk.fileHash,
		mtimeMs: chunk.mtimeMs,
		size: chunk.size,
		vector: chunk.vector,
	};
}

export async function upsertFileChunks(project: ProjectInfo, chunks: Array<CodeChunk & { vector: number[] }>, manifest: Manifest): Promise<void> {
	if (chunks.length === 0) return;
	const conn = await db(project);
	let table: any;
	if ((await conn.tableNames()).includes(TABLE_NAME)) {
		table = await conn.openTable(TABLE_NAME);
		await table.delete(`path = '${escapeSql(chunks[0].path)}'`).catch(() => undefined);
		await table.add(chunks.map(rowFromChunk));
	} else {
		table = await conn.createTable(TABLE_NAME, chunks.map(rowFromChunk));
	}
	const first = chunks[0];
	manifest.files[first.path] = {
		path: first.path,
		fileHash: first.fileHash,
		mtimeMs: first.mtimeMs,
		size: first.size,
		chunkIds: chunks.map((c) => c.id),
	} satisfies ManifestFileEntry;
	manifest.chunkCount = Object.values(manifest.files).reduce((sum, f) => sum + f.chunkIds.length, 0);
}

export async function deleteFileChunks(project: ProjectInfo, relPath: string, manifest?: Manifest): Promise<void> {
	if (await tableExists(project)) {
		const conn = await db(project);
		const table = await conn.openTable(TABLE_NAME);
		await table.delete(`path = '${escapeSql(relPath)}'`).catch(() => undefined);
	}
	if (manifest) delete manifest.files[relPath];
}

// Existing embeddings for a file, keyed by contentHash, so the incremental indexer can reuse the
// vectors of chunks that did not change instead of paying to re-embed them.
export async function getFileChunkVectors(project: ProjectInfo, relPath: string): Promise<Map<string, number[]>> {
	const map = new Map<string, number[]>();
	if (!(await tableExists(project))) return map;
	const conn = await db(project);
	const table = await conn.openTable(TABLE_NAME);
	const rows = await table
		.query()
		.where(`path = '${escapeSql(relPath)}'`)
		.toArray()
		.catch(() => [] as any[]);
	for (const r of rows) {
		if (typeof r.contentHash === "string" && r.vector) map.set(r.contentHash, Array.from(r.vector as ArrayLike<number>));
	}
	return map;
}

export async function maybeBuildAnnIndex(project: ProjectInfo, manifest: Manifest, config: ResolvedConfig): Promise<void> {
	if (manifest.annIndexBuilt || manifest.chunkCount < config.annIndexThreshold) return;
	try {
		const conn = await db(project);
		const table = await conn.openTable(TABLE_NAME);
		await table.createIndex("vector");
		manifest.annIndexBuilt = true;
	} catch {
		// Flat scan remains correct. Leave ANN absent if LanceDB cannot build it for this dataset.
	}
}

export interface SearchResult {
	path: string;
	language: string;
	symbol?: string;
	startLine: number;
	endLine: number;
	content: string;
	score: number;
}

export async function searchIndex(project: ProjectInfo, vector: number[], topK: number, filter?: string): Promise<SearchResult[]> {
	if (!(await tableExists(project))) return [];
	const conn = await db(project);
	const table = await conn.openTable(TABLE_NAME);
	let q = table.vectorSearch(vector).limit(topK);
	if (filter) q = q.where(filter);
	const rows = await q.toArray();
	return rows.map((r: any) => ({
		path: r.path,
		language: r.language,
		symbol: r.symbol || undefined,
		startLine: r.startLine,
		endLine: r.endLine,
		content: r.content,
		score: typeof r._distance === "number" ? 1 / (1 + r._distance) : 0,
	}));
}
