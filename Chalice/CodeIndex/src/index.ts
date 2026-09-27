import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearIndex, loadManifest, manifestCompatible } from "./store.ts";
import { buildTagResolver, computeTagStats, EMPTY_TAGS_HELP, formatDeclaredTags, listDeclaredTags } from "./tagging.ts";
import { getProjectInfo } from "./project.ts";
import { loadGlobalConfig, loadProjectState, resolveConfig, saveProjectState } from "./config.ts";
import { estimateIndex, incrementalRefresh, reindexProject, removeNonIndexableFiles, type ProgressUpdate } from "./indexer.ts";
import { estimateChunksForFile } from "./chunking.ts";
import type { IndexEstimate, Manifest, ResolvedConfig } from "./types.ts";
import { listIndexableFiles, readSourceFile } from "./filtering.ts";
import { registerTools } from "./tool.ts";
import { confirmEstimate, estimateText, runConfigWizard, updateFooter } from "./ui.ts";
import { CodeIndexWatcher } from "./watcher.ts";
import type { ProjectInfo, RuntimeStatus } from "./types.ts";

const MIN_INDEXING_STATUS_MS = 500;

export default function codeIndexExtension(pi: ExtensionAPI): void {
	let watcher: CodeIndexWatcher | undefined;
	let status: RuntimeStatus = { state: "off" };
	let indexingStatusSince: number | undefined;
	let readyStatusTimer: NodeJS.Timeout | undefined;
	let sessionGeneration = 0;
	let sessionActive = false;

	function isStaleContextError(error: unknown): boolean {
		return error instanceof Error && error.message.includes("This extension ctx is stale");
	}

	function shouldApplyStatus(generation: number): boolean {
		return sessionActive && generation === sessionGeneration;
	}

	function clearReadyStatusTimer(): void {
		if (readyStatusTimer) clearTimeout(readyStatusTimer);
		readyStatusTimer = undefined;
	}

	function applyStatus(ctx: ExtensionContext, next: RuntimeStatus): void {
		status = next;
		try {
			updateFooter(ctx, status);
		} catch (error) {
			if (isStaleContextError(error)) return;
			throw error;
		}
	}

	function setStatus(ctx: ExtensionContext, next: RuntimeStatus, generation = sessionGeneration): void {
		if (!shouldApplyStatus(generation)) return;
		if (next.state === "indexing") {
			clearReadyStatusTimer();
			indexingStatusSince = Date.now();
			applyStatus(ctx, next);
			return;
		}

		if (next.state === "ready" && status.state === "indexing" && indexingStatusSince !== undefined) {
			const remainingMs = MIN_INDEXING_STATUS_MS - (Date.now() - indexingStatusSince);
			if (remainingMs > 0) {
				clearReadyStatusTimer();
				readyStatusTimer = setTimeout(() => {
					readyStatusTimer = undefined;
					if (!shouldApplyStatus(generation)) return;
					indexingStatusSince = undefined;
					applyStatus(ctx, next);
				}, remainingMs);
				return;
			}
		}

		clearReadyStatusTimer();
		indexingStatusSince = undefined;
		applyStatus(ctx, next);
	}

	async function computeStatus(project: ProjectInfo): Promise<RuntimeStatus> {
		const { project: state, resolved } = await resolveConfig(project);
		if (!project.safe) return { state: "error", lastError: project.reason, message: project.reason };
		if (!state.enabled) return { state: "off" };
		const manifest = await loadManifest(project);
		if (!manifest) return { state: "not-indexed" };
		const compatible = manifestCompatible(manifest, resolved);
		if (!compatible.ok) return { state: "stale", message: compatible.reason };
		return { state: "ready", chunks: manifest.chunkCount };
	}

	async function stopWatcher(): Promise<void> {
		if (watcher) await watcher.stop();
		watcher = undefined;
	}

	async function startWatcher(ctx: ExtensionContext, project: ProjectInfo, generation = sessionGeneration): Promise<void> {
		await stopWatcher();
		if (!shouldApplyStatus(generation)) return;
		const { resolved } = await resolveConfig(project);
		if (!shouldApplyStatus(generation)) return;
		const nextWatcher = new CodeIndexWatcher(project, resolved, {
			onIndexing: (path) => setStatus(ctx, { state: "indexing", message: path }, generation),
			onReady: async () => setStatus(ctx, await computeStatus(project), generation),
			onBulkPending: (count) => setStatus(ctx, { state: "bulk-pending", message: `${count} changes pending · run /index update` }, generation),
			onError: (error) => setStatus(ctx, { state: "error", lastError: error instanceof Error ? error.message : String(error) }, generation),
		});
		watcher = nextWatcher;
		await nextWatcher.start();
		if (!shouldApplyStatus(generation)) await nextWatcher.stop();
	}

	async function pendingIndexChanges(
		project: ProjectInfo,
		config: ResolvedConfig,
		manifest: Manifest,
	): Promise<{ count: number; indexableFiles: string[] }> {
		const indexableFiles = await listIndexableFiles(project, config);
		const indexableSet = new Set(indexableFiles);
		const pending = new Set<string>();
		for (const path of Object.keys(manifest.files)) {
			if (!indexableSet.has(path)) pending.add(path);
		}
		for (const path of indexableFiles) {
			const source = await readSourceFile(project, path, config);
			const entry = manifest.files[path];
			if (!source) {
				if (entry) pending.add(path);
				continue;
			}
			if (!entry || entry.fileHash !== source.fileHash) pending.add(path);
		}
		return { count: pending.size, indexableFiles };
	}

	async function runIncrementalUpdate(
		ctx: ExtensionContext,
		project: ProjectInfo,
		config: ResolvedConfig,
		signal: AbortSignal | undefined,
		indexableFiles?: string[],
		generation = sessionGeneration,
	): Promise<Manifest | undefined> {
		const manifest = await loadManifest(project);
		if (!manifest) return undefined;
		const files = indexableFiles ?? (await listIndexableFiles(project, config));
		await removeNonIndexableFiles(project, manifest, new Set(files));
		return incrementalRefresh(project, config, signal, (p: ProgressUpdate) =>
			setStatus(ctx, { state: "indexing", filesDone: p.filesDone, filesTotal: p.filesTotal, chunks: p.chunks, message: "updating" }, generation),
		);
	}

	async function reconcileOnSessionStart(ctx: ExtensionContext, project: ProjectInfo, generation: number, signal: AbortSignal | undefined): Promise<void> {
		const { resolved } = await resolveConfig(project);
		if (!shouldApplyStatus(generation)) return;
		const manifest = await loadManifest(project);
		const compatible = manifestCompatible(manifest, resolved);
		if (!manifest || !compatible.ok) return;
		const pending = await pendingIndexChanges(project, resolved, manifest);
		if (!shouldApplyStatus(generation) || pending.count === 0) return;
		if (pending.count > resolved.watcherBulkThreshold) {
			watcher?.markBulkPending(pending.count);
			return;
		}
		if (!resolved.apiKeyPresent && resolved.provider !== "local") {
			setStatus(ctx, { state: "error", lastError: `Missing API key env ${resolved.apiKeyEnv}` }, generation);
			return;
		}
		setStatus(ctx, { state: "indexing", message: "startup update" }, generation);
		const refreshed = await runIncrementalUpdate(ctx, project, resolved, signal, pending.indexableFiles, generation);
		if (!shouldApplyStatus(generation)) return;
		watcher?.clearPending();
		setStatus(ctx, { state: "ready", chunks: refreshed?.chunkCount ?? manifest.chunkCount }, generation);
	}

	async function showStatus(ctx: ExtensionContext): Promise<void> {
		const project = await getProjectInfo(ctx.cwd);
		const { project: state, resolved } = await resolveConfig(project);
		const manifest = await loadManifest(project);
		const compatible = manifestCompatible(manifest, resolved);
		const lines = [
			`Project: ${project.root}`,
			`Safe: ${project.safe ? "yes" : `no (${project.reason})`}`,
			`Enabled: ${state.enabled ? "yes" : "no"}`,
			`Provider: ${resolved.provider}`,
			`Model: ${resolved.model}`,
			`Base URL: ${resolved.baseUrl}`,
			`API key env: ${resolved.apiKeyEnv ?? "(none)"} (${resolved.apiKeyPresent ? "set" : "missing"})`,
			`Index: ${manifest ? `${manifest.fileCount} files, ${manifest.chunkCount} chunks, dim ${manifest.embeddingDim}` : "not built"}`,
			`Compatibility: ${compatible.ok ? "ok" : compatible.reason}`,
			state.lastError ? `Last error: ${state.lastError}` : undefined,
		].filter(Boolean);
		ctx.ui.notify(lines.join("\n"), compatible.ok || !manifest ? "info" : "warning");
		setStatus(ctx, await computeStatus(project));
	}

	async function runReindex(ctx: ExtensionContext, project: ProjectInfo, forceConfirm = false): Promise<void> {
		const { resolved } = await resolveConfig(project);
		if (!resolved.apiKeyPresent && resolved.provider !== "local") throw new Error(`Missing API key env ${resolved.apiKeyEnv}`);
		const estimate = await estimateIndex(project, resolved);
		const needsConfirm = forceConfirm || estimate.chunks >= resolved.largeRepoConfirmChunks;
		const ok = await confirmEstimate(ctx, estimate, needsConfirm);
		if (!ok) {
			ctx.ui.notify("Indexing cancelled", "info");
			return;
		}
		setStatus(ctx, { state: "indexing", filesDone: 0, filesTotal: estimate.files, chunks: 0 });
		const manifest = await reindexProject(project, resolved, ctx.signal, (p: ProgressUpdate) => {
			setStatus(ctx, { state: "indexing", filesDone: p.filesDone, filesTotal: p.filesTotal, chunks: p.chunks, message: p.phase });
		});
		setStatus(ctx, { state: "ready", chunks: manifest.chunkCount });
		ctx.ui.notify(`Code index ready: ${manifest.fileCount} files, ${manifest.chunkCount} chunks`, "info");
	}

	pi.registerCommand("index", {
		description: "Manage semantic code index: status|on|off|update|reindex|clear|config|tags|help",
		handler: async (args, ctx) => {
			const sub = (args || "status").trim().split(/\s+/)[0] || "status";
			const project = await getProjectInfo(ctx.cwd);
			try {
				if (sub === "status") return showStatus(ctx);
				if (sub === "config") {
					const current = await loadGlobalConfig();
					await runConfigWizard(ctx, current);
					setStatus(ctx, await computeStatus(project));
					return;
				}
				if (!project.safe) throw new Error(project.reason ?? "unsafe project root");
				const state = await loadProjectState(project);
				if (sub === "off") {
					await saveProjectState(project, { ...state, enabled: false });
					await stopWatcher();
					setStatus(ctx, { state: "off" });
					ctx.ui.notify("Code index disabled for this project", "info");
					return;
				}
				if (sub === "clear") {
					await clearIndex(project);
					setStatus(ctx, state.enabled ? { state: "not-indexed" } : { state: "off" });
					ctx.ui.notify("Code index cleared", "info");
					return;
				}
				if (sub === "on") {
					if (!state.dataEgressConfirmed) {
						const { resolved } = await resolveConfig(project);
						if (resolved.provider !== "local") {
							if (!ctx.hasUI) throw new Error("First /index on requires interactive confirmation because source code will be sent to the embedding provider.");
							const ok = await ctx.ui.confirm("Code indexing data egress", `Indexing sends source-code chunks to ${resolved.provider} (${resolved.baseUrl}) for embeddings. Secret-pattern files are skipped. Continue?`);
							if (!ok) return;
						}
					}
					await saveProjectState(project, { ...state, enabled: true, dataEgressConfirmed: true, lastError: undefined });
					await stopWatcher(); // stop any watcher from a prior session/enable before touching the index
					const { resolved } = await resolveConfig(project);
					const manifest = await loadManifest(project);
					const compatible = manifestCompatible(manifest, resolved);
					if (!manifest || !compatible.ok) {
						await runReindex(ctx, project, !manifest);
					} else {
						// Existing compatible index: reconcile files changed while pi was closed.
						// Incremental (only changed files re-embed) — never a full reindex on enable.
						setStatus(ctx, { state: "indexing", message: "reconciling" });
						const refreshed = await incrementalRefresh(project, resolved, ctx.signal, (p: ProgressUpdate) => setStatus(ctx, { state: "indexing", filesDone: p.filesDone, filesTotal: p.filesTotal, chunks: p.chunks, message: "reconciling" }));
						setStatus(ctx, { state: "ready", chunks: refreshed?.chunkCount ?? manifest.chunkCount });
						ctx.ui.notify("Code index enabled; reconciled, watcher running", "info");
					}
					await startWatcher(ctx, project); // start only after (re)build/reconcile so it cannot race the rebuild
					return;
				}
				if (sub === "reindex") {
					await saveProjectState(project, { ...state, enabled: true, lastError: undefined });
					await stopWatcher(); // stop any prior watcher before clearIndex wipes the index dir
					await runReindex(ctx, project, true);
					await startWatcher(ctx, project); // start after the rebuild completes
					return;
				}
				if (sub === "update") {
					const manifest = await loadManifest(project);
					if (!manifest) {
						ctx.ui.notify("No index found. Run /index reindex first.", "error");
						return;
					}
					const { resolved } = await resolveConfig(project);
					const compatible = manifestCompatible(manifest, resolved);
					if (!compatible.ok) {
						ctx.ui.notify(`Index is stale (${compatible.reason}). Run /index reindex.`, "error");
						return;
					}
					// Phase 1 (free): remove chunks for files that are no longer indexable
					setStatus(ctx, { state: "indexing", message: "pruning removed/excluded files" });
					const indexableFiles = await listIndexableFiles(project, resolved);
					const indexableSet = new Set(indexableFiles);
					const removed = await removeNonIndexableFiles(project, manifest, indexableSet);
					// Phase 2: compute the real incremental embed cost (new + hash-changed files)
					const freshManifest = await loadManifest(project) ?? manifest;
					// Identify files that actually need embedding: new (not in manifest) or content-changed.
					const toEmbedPaths: string[] = [];
					for (const p of indexableFiles) {
						const source = await readSourceFile(project, p, resolved);
						if (!source) continue;
						const entry = freshManifest.files[p];
						if (!entry || entry.fileHash !== source.fileHash) toEmbedPaths.push(p);
					}
					if (toEmbedPaths.length > 0) {
						if (!resolved.apiKeyPresent && resolved.provider !== "local") {
							throw new Error(`Missing API key env ${resolved.apiKeyEnv}`);
						}
						// Accumulate real incremental chunks/tokens/cost for the files that need embedding.
						let incChunks = 0;
						let incTokens = 0;
						for (const p of toEmbedPaths) {
							const source = await readSourceFile(project, p, resolved);
							if (!source) continue;
							const est = await estimateChunksForFile(source, project.root, resolved);
							incChunks += est.chunks.length;
							incTokens += est.tokens;
						}
						const incCost = resolved.pricePerMillionTokens === undefined ? undefined : (incTokens / 1_000_000) * resolved.pricePerMillionTokens;
						const incEstimate: IndexEstimate = { files: toEmbedPaths.length, chunks: incChunks, estimatedTokens: incTokens, estimatedCost: incCost, model: resolved.model, baseUrl: resolved.baseUrl };
						// Align with reindex confirmation threshold: chunks (not file count) vs largeRepoConfirmChunks.
						const needsConfirm = incChunks >= resolved.largeRepoConfirmChunks;
						const ok = await confirmEstimate(ctx, incEstimate, needsConfirm);
						if (!ok) {
							ctx.ui.notify(`Update cancelled. Removed ${removed} files' chunks (free).`, "info");
							setStatus(ctx, await computeStatus(project));
							return;
						}
					}
					setStatus(ctx, { state: "indexing", message: "embedding new/changed files" });
					const refreshed = await incrementalRefresh(project, resolved, ctx.signal, (p: ProgressUpdate) =>
						setStatus(ctx, { state: "indexing", filesDone: p.filesDone, filesTotal: p.filesTotal, chunks: p.chunks, message: "updating" }),
					);
					// Clear bulk-pending flag now that the index is up to date
					if (watcher) watcher.clearPending();
					setStatus(ctx, { state: "ready", chunks: refreshed?.chunkCount ?? freshManifest.chunkCount });
					ctx.ui.notify(`removed ${removed} chunks (free) · embedded ${toEmbedPaths.length} files`, "info");
					return;
				}
				if (sub === "tags") {
					const { resolved: tagsResolved } = await resolveConfig(project);
					const tagMap = await listDeclaredTags(project.root, new Set(tagsResolved.excludeDirs));
					if (tagMap.size === 0) {
						ctx.ui.notify(EMPTY_TAGS_HELP, "info");
						return;
					}
					const manifest = await loadManifest(project);
					const filePaths = manifest ? Object.keys(manifest.files) : [];
					const tagResolver = await buildTagResolver(project.root, new Set(tagsResolved.excludeDirs));
					const stats = computeTagStats(filePaths, (p) => tagResolver.resolveTags(p));
					ctx.ui.notify(formatDeclaredTags(tagMap, stats), "info");
					return;
				}
				if (sub === "help") {
					const helpText = [
						"/index subcommands:",
						"  status   — show index state, file/chunk counts, config",
						"  on       — enable indexing for this project (builds index if needed)",
						"  off      — disable indexing and stop watcher",
						"  update   — incremental sync: removes excluded/deleted chunks (free), embeds new/changed files (with cost confirmation)",
						"  reindex  — full rebuild from scratch (always confirms cost)",
						"  clear    — wipe the index without disabling",
						"  config   — open settings wizard",
						"  tags     — list all tags declared in .index_tag files (read-only, no reindex needed)",
						"  help     — show this message",
						"",
						"Ignore layers (most authoritative first):",
						"  1. git (all four layers: .gitignore, nested .gitignore, core.excludesFile, .git/info/exclude)",
						"  2. .indexignore  — project-local extra excludes for the code index",
						"  3. .contextignore — shared context exclusions",
						"  4. excludeDirs config — built-in directory exclusions",
						"",
						"Use .indexignore to narrow what gets indexed without touching git ignore rules.",
					].join("\n");
					ctx.ui.notify(helpText, "info");
					return;
				}
				ctx.ui.notify(`Unknown /index subcommand: ${sub}. Run /index help for usage.`, "error");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const state = await loadProjectState(project).catch(() => ({ enabled: false }));
				await saveProjectState(project, { ...state, lastError: message }).catch(() => undefined);
				setStatus(ctx, { state: "error", lastError: message });
				ctx.ui.notify(`Code index error: ${message}`, "error");
			}
		},
	});

	registerTools(pi);

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++sessionGeneration;
		sessionActive = true;
		const signal = ctx.signal;
		const project = await getProjectInfo(ctx.cwd);
		const state = await loadProjectState(project);
		setStatus(ctx, await computeStatus(project), generation);
		if (project.safe && state.enabled) {
			await startWatcher(ctx, project, generation);
			await reconcileOnSessionStart(ctx, project, generation, signal);
		}
	});

	pi.on("session_shutdown", async () => {
		sessionActive = false;
		sessionGeneration++;
		clearReadyStatusTimer();
		indexingStatusSince = undefined;
		await stopWatcher();
	});
}
