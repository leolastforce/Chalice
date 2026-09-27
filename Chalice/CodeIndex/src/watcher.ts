import chokidar, { type FSWatcher } from "chokidar";
import { relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectInfo, ResolvedConfig } from "./types.ts";
import { buildIgnoreMatcher, isPathIndexable, isSecretPath } from "./filtering.ts";
import { deleteFileChunks, loadManifest, manifestCompatible, saveManifest } from "./store.ts";
import { updateChangedFile } from "./indexer.ts";

const execFileAsync = promisify(execFile);

async function isGitRepo(root: string): Promise<boolean> {
	try {
		await execFileAsync("git", ["-C", root, "rev-parse", "--git-dir"], { timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

export interface WatcherCallbacks {
	onIndexing?: (path: string) => void;
	onReady?: () => void;
	onBulkPending?: (count: number) => void;
	onError?: (error: unknown) => void;
}

export class CodeIndexWatcher {
	private watcher?: FSWatcher;
	private timer?: NodeJS.Timeout;
	private pending = new Set<string>();
	// When the debounce window accumulates more than watcherBulkThreshold changes, auto-embed is
	// suspended. The watcher sets this flag and fires onBulkPending; /index update clears it.
	private bulkPending = false;
	// Cumulative count of files seen while in bulk-pending state (displayed in footer).
	private bulkCount = 0;
	// Serialize flushes: a debounce that fires while a flush is still awaiting embeddings must not
	// start a second concurrent flush (they would race on the manifest and orphan rows).
	private flushing: Promise<void> = Promise.resolve();
	private stopped = true;
	private abortController = new AbortController();

	constructor(
		private project: ProjectInfo,
		private config: ResolvedConfig,
		private callbacks: WatcherCallbacks = {},
	) {}

	// Called when startup reconciliation finds too many out-of-band changes to auto-embed.
	markBulkPending(count: number): void {
		if (this.stopped) return;
		this.bulkPending = true;
		this.bulkCount = count;
		this.callbacks.onBulkPending?.(this.bulkCount);
	}

	// Called by /index update after a successful update to clear the bulk-pending state.
	clearPending(): void {
		this.bulkPending = false;
		this.bulkCount = 0;
	}

	async start(): Promise<void> {
		if (this.watcher) return;
		this.stopped = false;
		this.abortController = new AbortController();
		const gitRepo = await isGitRepo(this.project.root);
		if (this.stopped) return;
		const ig = await buildIgnoreMatcher(this.project, this.config, gitRepo);
		if (this.stopped) return;
		this.watcher = chokidar.watch(this.project.root, {
			ignoreInitial: true,
			persistent: true,
			followSymlinks: false,
			ignored: (path) => {
				const rel = relative(this.project.root, path).replaceAll("\\", "/");
				if (!rel || rel.startsWith("..")) return false;
				if (ig.ignores(rel)) return true;
				if (isSecretPath(rel)) return true;
				// Keep all non-ignored files watched; unknown readable files are indexed as plain text.
				return false;
			},
		});
		this.watcher.on("add", (p) => this.enqueue(p));
		this.watcher.on("change", (p) => this.enqueue(p));
		this.watcher.on("unlink", (p) => this.enqueue(p, true));
	}

	private enqueue(absPath: string, deleted = false): void {
		if (this.stopped) return;
		const rel = relative(this.project.root, absPath).replaceAll("\\", "/");
		if (!rel || rel.startsWith("..")) return;
		this.pending.add(deleted ? `!${rel}` : rel);
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.flushing = this.flushing.then(() => this.flush(), () => this.flush());
		}, this.config.watcherDebounceMs);
	}

	private async flush(): Promise<void> {
		if (this.stopped) {
			this.pending.clear();
			return;
		}
		const items = [...this.pending];
		this.pending.clear();
		if (items.length === 0) return;

		// If the debounce window accumulated more changes than the bulk threshold, suspend auto-embed
		// and notify the caller to show a warning. The user must run /index update manually.
		const threshold = this.config.watcherBulkThreshold;
		if (items.length > threshold) {
			this.bulkPending = true;
			this.bulkCount += items.length;
			if (!this.stopped) this.callbacks.onBulkPending?.(this.bulkCount);
			return;
		}

		// If already in bulk-pending state, keep accumulating without auto-embedding until cleared.
		if (this.bulkPending) {
			this.bulkCount += items.length;
			if (!this.stopped) this.callbacks.onBulkPending?.(this.bulkCount);
			return;
		}

		for (const item of items) {
			if (this.stopped || this.abortController.signal.aborted) return;
			try {
				const deleted = item.startsWith("!");
				const rel = deleted ? item.slice(1) : item;
				this.callbacks.onIndexing?.(rel);
				const manifest = await loadManifest(this.project);
				const compatible = manifestCompatible(manifest, this.config);
				if (!manifest || !compatible.ok) {
					if (!this.stopped) this.callbacks.onReady?.();
					continue;
				}
				if (deleted) {
					await deleteFileChunks(this.project, rel, manifest);
					await saveManifest(this.project, manifest);
				} else if (await isPathIndexable(this.project, this.config, rel)) {
					await updateChangedFile(this.project, this.config, rel, this.abortController.signal);
				} else {
					await deleteFileChunks(this.project, rel, manifest);
					await saveManifest(this.project, manifest);
				}
				if (!this.stopped) this.callbacks.onReady?.();
			} catch (error) {
				if (!this.stopped && !this.abortController.signal.aborted) this.callbacks.onError?.(error);
			}
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.abortController.abort();
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
		if (this.watcher) await this.watcher.close();
		this.watcher = undefined;
		await this.flushing.catch(() => undefined); // let any in-flight flush finish writing
	}
}
