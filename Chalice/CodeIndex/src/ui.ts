import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INDEX_AFFECTING_KEYS, PROVIDER_PRESETS, saveGlobalConfig } from "./config.ts";
import type { GlobalConfig, IndexEstimate, ProviderId, RuntimeStatus } from "./types.ts";

export function updateFooter(ctx: ExtensionContext, status: RuntimeStatus): void {
	const t = ctx.ui.theme;
	let text: string;
	switch (status.state) {
		case "off":
			text = t.fg("dim", "off");
			break;
		case "not-indexed":
			text = t.fg("warning", "not indexed");
			break;
		case "indexing": {
			const progress = status.filesTotal ? ` ${status.filesDone ?? 0}/${status.filesTotal}` : "";
			const chunks = status.chunks !== undefined ? ` ${status.chunks} chunks` : "";
			text = t.fg("accent", `indexing${progress}${chunks}`);
			break;
		}
		case "ready":
			text = t.fg("success", `ready${status.chunks !== undefined ? ` ${status.chunks} chunks` : ""}`);
			break;
		case "stale":
			text = t.fg("warning", `stale${status.message ? ` ${status.message}` : ""}`);
			break;
		case "bulk-pending":
			text = t.fg("warning", status.message ?? "changes pending · run /index update");
			break;
		case "error":
			text = t.fg("error", "error");
			break;
	}
	ctx.ui.setStatus("code-index", text);
}

export function estimateText(estimate: IndexEstimate): string {
	const cost = estimate.estimatedCost === undefined ? "unknown" : `$${estimate.estimatedCost.toFixed(4)}`;
	return [`Index estimate:`, `- files: ${estimate.files}`, `- chunks: ${estimate.chunks}`, `- estimated input tokens: ${estimate.estimatedTokens.toLocaleString()}`, `- model: ${estimate.model}`, `- estimated cost: ${cost}`].join("\n");
}

export async function confirmEstimate(ctx: ExtensionContext, estimate: IndexEstimate, shouldConfirm: boolean): Promise<boolean> {
	if (!ctx.hasUI) return true;
	if (!shouldConfirm) return true;
	return ctx.ui.confirm("Confirm code indexing", `${estimateText(estimate)}\n\nSource code will be sent to the configured embedding provider unless using a local preset. Proceed?`);
}

// Scalar settings the menu can edit inline. Whether a change requires reindex is decided by
// INDEX_AFFECTING_KEYS (shared with manifestCompatible) — not duplicated here — so the "prompt
// reindex" set and the "detect stale" set stay one source of truth.
type NumericField = { key: string; label: string; min: number; max?: number; integer: boolean };
const NUMERIC_FIELDS: NumericField[] = [
	{ key: "maxTopK", label: "Max top-K (search)", min: 1, max: 256, integer: true },
	{ key: "scoreThreshold", label: "Score threshold (0=off)", min: 0, max: 1, integer: false },
	{ key: "chunkOverlapChars", label: "Chunk overlap chars (0=off)", min: 0, max: 4000, integer: true },
	{ key: "maxChunkChars", label: "Max chunk chars", min: 200, max: 60_000, integer: true },
	{ key: "chunkLines", label: "Window size (lines)", min: 10, max: 2000, integer: true },
	{ key: "chunkOverlap", label: "Window overlap (lines)", min: 0, max: 500, integer: true },
	{ key: "requestConcurrency", label: "Request concurrency", min: 1, max: 16, integer: true },
	{ key: "batchSize", label: "Embed batch size", min: 1, max: 256, integer: true },
	{ key: "watcherDebounceMs", label: "Watcher debounce (ms)", min: 0, max: 60_000, integer: true },
	{ key: "largeRepoConfirmChunks", label: "Large-repo confirm (chunks)", min: 0, integer: true },
	{ key: "annIndexThreshold", label: "ANN index threshold", min: 0, integer: true },
	{ key: "maxFileBytes", label: "Max file bytes", min: 1024, integer: true },
];

// A looping select-menu acts as a settings dialog: each row shows a field and its current value;
// picking one opens an input/sub-select to edit it, then returns to the menu. Save persists, Cancel
// (or ESC) discards the whole draft. Only select/input/confirm primitives are needed.
export async function runConfigWizard(ctx: ExtensionContext, current: GlobalConfig): Promise<GlobalConfig | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/index config requires UI mode", "error");
		return undefined;
	}
	const draft: GlobalConfig = { ...current };
	const num = draft as unknown as Record<string, number>;
	let dirty = false;
	const affected = new Set<string>();

	const editProvider = async (): Promise<void> => {
		const p = (await ctx.ui.select("Embedding provider", ["voyage", "openrouter", "local", "custom"], { timeout: 120_000 })) as ProviderId | undefined;
		if (!p || p === draft.provider) return;
		draft.provider = p;
		dirty = true;
		affected.add("provider");
		const preset = PROVIDER_PRESETS[p];
		if (p === "custom") {
			// Seed the editable fields from the prior values or the preset so they aren't blank.
			draft.baseUrl = draft.baseUrl ?? preset.baseUrl;
			draft.model = draft.model ?? preset.model;
			draft.apiKeyEnv = draft.apiKeyEnv ?? preset.apiKeyEnv;
		} else {
			// Adopt the preset and clear any prior custom overrides.
			draft.baseUrl = undefined;
			draft.model = undefined;
			draft.apiKeyEnv = undefined;
			draft.embeddingDim = undefined;
		}
	};

	const editText = async (key: "baseUrl" | "model" | "apiKeyEnv", label: string): Promise<void> => {
		const fallback = PROVIDER_PRESETS[draft.provider][key];
		const v = await ctx.ui.input(label, draft[key] ?? fallback ?? "");
		if (v === undefined) return;
		draft[key] = v.trim() || undefined;
		dirty = true;
		if (key === "model" || key === "baseUrl") affected.add(key);
	};

	const editNumeric = async (f: NumericField): Promise<void> => {
		const raw = await ctx.ui.input(f.label, String(num[f.key]));
		if (raw === undefined) return;
		// Number() (not parseInt/parseFloat) rejects trailing garbage like "12abc"; integer fields also
		// reject fractions. Invalid input notifies and leaves the current value untouched.
		const trimmed = raw.trim();
		const v = Number(trimmed);
		if (trimmed === "" || !Number.isFinite(v) || (f.integer && !Number.isInteger(v)) || v < f.min || (f.max !== undefined && v > f.max)) {
			ctx.ui.notify(`Invalid ${f.label}: need ${f.integer ? "an integer" : "a number"} in [${f.min}, ${f.max ?? "∞"}]`, "error");
			return;
		}
		if (v !== num[f.key]) {
			num[f.key] = v;
			dirty = true;
			if ((INDEX_AFFECTING_KEYS as readonly string[]).includes(f.key)) affected.add(f.label);
		}
	};

	const editList = async (key: "excludeDirs", label: string): Promise<void> => {
		const raw = await ctx.ui.input(`${label} (comma-separated)`, draft[key].join(","));
		if (raw === undefined) return;
		const arr = raw.split(",").map((s) => s.trim()).filter(Boolean);
		if (arr.length === 0) {
			ctx.ui.notify(`${label} cannot be empty`, "error");
			return;
		}
		draft[key] = arr;
		dirty = true;
		affected.add(label);
	};

	while (true) {
		const actions = new Map<string, () => Promise<void>>();
		const items: string[] = [];
		const add = (label: string, fn: () => Promise<void>): void => {
			items.push(label);
			actions.set(label, fn);
		};
		add(`Provider: ${draft.provider}`, editProvider);
		if (draft.provider === "custom") {
			add(`  Model: ${draft.model ?? "(preset)"}`, () => editText("model", "Embedding model"));
			add(`  Base URL: ${draft.baseUrl ?? "(preset)"}`, () => editText("baseUrl", "Embedding base URL"));
			add(`  API key env: ${draft.apiKeyEnv ?? "(preset)"}`, () => editText("apiKeyEnv", "API key env var (no literal keys stored)"));
		}
		for (const f of NUMERIC_FIELDS) add(`${f.label}: ${num[f.key]}`, () => editNumeric(f));
		add(`Exclude dirs: ${draft.excludeDirs.length} dirs`, () => editList("excludeDirs", "Exclude dirs"));

		const saveLabel = dirty ? "✓ Save & close" : "Close";
		const cancelLabel = "✗ Cancel (discard changes)";
		items.push(saveLabel, cancelLabel);

		const choice = await ctx.ui.select("Code Index Settings", items, { timeout: 300_000 });
		if (choice === undefined || choice === cancelLabel) return undefined;
		if (choice === saveLabel) break;
		const act = actions.get(choice);
		if (act) await act();
	}

	if (!dirty) return current;
	await saveGlobalConfig(draft);
	const keyEnv = draft.apiKeyEnv ?? PROVIDER_PRESETS[draft.provider].apiKeyEnv;
	const keyState = draft.provider === "local" ? "no key needed" : keyEnv && process.env[keyEnv] ? `${keyEnv} set` : `${keyEnv ?? "API key"} missing`;
	let msg = `Settings saved (provider ${draft.provider}, ${keyState}).`;
	if (affected.size) msg += ` Index-affecting changes: ${[...affected].join(", ")} — run /index reindex to apply (never automatic).`;
	ctx.ui.notify(msg, "info");
	return draft;
}
