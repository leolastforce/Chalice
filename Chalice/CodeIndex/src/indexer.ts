import { stat } from "node:fs/promises";
import type { IndexEstimate, Manifest, ProjectInfo, ResolvedConfig } from "./types.ts";
import { INDEX_VERSION } from "./types.ts";
import { chunkSourceFile, estimateChunksForFile, estimateTokens } from "./chunking.ts";
import { embedTexts } from "./embeddings.ts";
import { listIndexableFiles, readSourceFile } from "./filtering.ts";
import { clearIndex, deleteFileChunks, getFileChunkVectors, loadManifest, manifestCompatible, maybeBuildAnnIndex, newManifest, saveManifest, upsertFileChunks } from "./store.ts";

export interface ProgressUpdate {
	filesDone: number;
	filesTotal: number;
	chunks: number;
	phase: "scanning" | "embedding" | "writing" | "done";
}

export async function estimateIndex(project: ProjectInfo, config: ResolvedConfig): Promise<IndexEstimate> {
	const files = await listIndexableFiles(project, config);
	let chunks = 0;
	let estimatedTokens = 0;
	for (const path of files) {
		const source = await readSourceFile(project, path, config);
		if (!source) continue;
		const est = await estimateChunksForFile(source, project.root, config);
		chunks += est.chunks.length;
		estimatedTokens += est.tokens;
	}
	const estimatedCost = config.pricePerMillionTokens === undefined ? undefined : (estimatedTokens / 1_000_000) * config.pricePerMillionTokens;
	return { files: files.length, chunks, estimatedTokens, estimatedCost, model: config.model, baseUrl: config.baseUrl };
}

export async function reindexProject(project: ProjectInfo, config: ResolvedConfig, signal?: AbortSignal, onProgress?: (p: ProgressUpdate) => void): Promise<Manifest> {
	await clearIndex(project);
	const files = await listIndexableFiles(project, config);
	let manifest: Manifest | undefined;
	let filesDone = 0;
	let chunksDone = 0;
	onProgress?.({ filesDone, filesTotal: files.length, chunks: chunksDone, phase: "scanning" });
	for (const path of files) {
		if (signal?.aborted) throw new Error("indexing aborted");
		const source = await readSourceFile(project, path, config);
		if (!source) {
			filesDone++;
			continue;
		}
		const chunks = await chunkSourceFile(source, project.root, config);
		if (chunks.length === 0) {
			filesDone++;
			continue;
		}
		onProgress?.({ filesDone, filesTotal: files.length, chunks: chunksDone, phase: "embedding" });
		const embedded = await embedTexts(config, chunks.map((c) => c.embeddedText), signal, "document");
		manifest ??= newManifest(project, config, embedded.dimension);
		if (manifest.embeddingDim && manifest.embeddingDim !== embedded.dimension) throw new Error(`embedding dimension changed: ${embedded.dimension} != ${manifest.embeddingDim}`);
		manifest.embeddingDim = embedded.dimension;
		const withVectors = chunks.map((c, i) => ({ ...c, vector: embedded.vectors[i] }));
		if (withVectors.some((c) => !c.vector || c.vector.length !== embedded.dimension)) throw new Error(`internal: incomplete vector set for ${path}`);
		onProgress?.({ filesDone, filesTotal: files.length, chunks: chunksDone, phase: "writing" });
		await upsertFileChunks(project, withVectors, manifest);
		// Checkpoint after every completed file so a later provider error can resume via /index on.
		await saveManifest(project, manifest);
		filesDone++;
		chunksDone += chunks.length;
		onProgress?.({ filesDone, filesTotal: files.length, chunks: chunksDone, phase: "embedding" });
	}
	manifest ??= newManifest(project, config, config.embeddingDim ?? 0);
	manifest.version = INDEX_VERSION;
	await maybeBuildAnnIndex(project, manifest, config);
	await saveManifest(project, manifest);
	onProgress?.({ filesDone, filesTotal: files.length, chunks: chunksDone, phase: "done" });
	return manifest;
}

export async function updateChangedFile(project: ProjectInfo, config: ResolvedConfig, relPath: string, signal?: AbortSignal): Promise<Manifest | undefined> {
	const manifest = await loadManifest(project);
	const compatible = manifestCompatible(manifest, config);
	if (!manifest || !compatible.ok) return manifest;
	const source = await readSourceFile(project, relPath, config);
	if (!source) {
		await deleteFileChunks(project, relPath, manifest);
		await saveManifest(project, manifest);
		return manifest;
	}
	const prev = manifest.files[relPath];
	if (prev?.fileHash === source.fileHash) return manifest;
	const chunks = await chunkSourceFile(source, project.root, config);
	if (chunks.length === 0) {
		await deleteFileChunks(project, relPath, manifest);
		await saveManifest(project, manifest);
		return manifest;
	}
	// Reuse vectors of chunks whose content is unchanged; only embed the ones that actually changed.
	const cached = await getFileChunkVectors(project, relPath);
	const vectors = new Array<number[]>(chunks.length);
	const missing: number[] = [];
	chunks.forEach((c, i) => {
		const hit = cached.get(c.contentHash);
		if (hit && hit.length === manifest.embeddingDim) vectors[i] = hit;
		else missing.push(i);
	});
	if (missing.length > 0) {
		const embedded = await embedTexts(config, missing.map((i) => chunks[i].embeddedText), signal, "document");
		if (embedded.dimension !== manifest.embeddingDim) throw new Error(`embedding dimension ${embedded.dimension} differs from manifest ${manifest.embeddingDim}; run /index reindex`);
		missing.forEach((idx, j) => (vectors[idx] = embedded.vectors[j]));
	}
	if (vectors.some((v) => !v || v.length !== manifest.embeddingDim)) throw new Error(`internal: incomplete vector set for ${relPath}`);
	await deleteFileChunks(project, relPath, manifest);
	await upsertFileChunks(project, chunks.map((c, i) => ({ ...c, vector: vectors[i] })), manifest);
	await saveManifest(project, manifest);
	return manifest;
}

export async function removeDeletedFiles(project: ProjectInfo, manifest: Manifest): Promise<Manifest> {
	for (const path of Object.keys(manifest.files)) {
		const exists = await stat(`${project.root}/${path}`).then((s) => s.isFile(), () => false);
		if (!exists) await deleteFileChunks(project, path, manifest);
	}
	await saveManifest(project, manifest);
	return manifest;
}

// Remove chunks for files that are no longer indexable — either disk-deleted or newly excluded by
// ignore rules. Returns the number of files whose chunks were removed (all free, no embed calls).
export async function removeNonIndexableFiles(project: ProjectInfo, manifest: Manifest, indexableSet: Set<string>): Promise<number> {
	let removed = 0;
	for (const path of Object.keys(manifest.files)) {
		const stillIndexable = indexableSet.has(path);
		if (!stillIndexable) {
			await deleteFileChunks(project, path, manifest);
			removed++;
		}
	}
	await saveManifest(project, manifest);
	return removed;
}

export async function incrementalRefresh(project: ProjectInfo, config: ResolvedConfig, signal?: AbortSignal, onProgress?: (p: ProgressUpdate) => void): Promise<Manifest | undefined> {
	const manifest = await loadManifest(project);
	const compatible = manifestCompatible(manifest, config);
	if (!manifest || !compatible.ok) return manifest;
	const files = await listIndexableFiles(project, config);
	let done = 0;
	for (const path of files) {
		const source = await readSourceFile(project, path, config);
		if (!source) continue;
		if (manifest.files[path]?.fileHash !== source.fileHash) await updateChangedFile(project, config, path, signal);
		done++;
		onProgress?.({ filesDone: done, filesTotal: files.length, chunks: manifest.chunkCount, phase: "embedding" });
	}
	// updateChangedFile re-loads/saves the manifest itself, so the snapshot above is now stale.
	// Reload fresh before pruning deleted files, otherwise this save would clobber those updates.
	const fresh = (await loadManifest(project)) ?? manifest;
	return removeDeletedFiles(project, fresh);
}
