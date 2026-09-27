import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GlobalConfig, ProjectInfo, ProjectState, ProviderId, ProviderPreset, ResolvedConfig } from "./types.ts";

export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const DATA_DIR = join(AGENT_DIR, "code-index");
export const GLOBAL_CONFIG_PATH = join(DATA_DIR, "config.json");
export const AUTH_FILE_PATH = join(AGENT_DIR, "auth.json");

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
	voyage: {
		id: "voyage",
		label: "Voyage AI (code, default)",
		baseUrl: "https://api.voyageai.com/v1/embeddings",
		model: "voyage-code-3",
		apiKeyEnv: "VOYAGE_API_KEY",
		embeddingDim: 1024,
		pricePerMillionTokens: 0.12,
	},
	openrouter: {
		id: "openrouter",
		label: "OpenRouter (general fallback)",
		baseUrl: "https://openrouter.ai/api/v1/embeddings",
		model: "openai/text-embedding-3-large",
		apiKeyEnv: "OPENROUTER_API_KEY",
		embeddingDim: 3072,
		pricePerMillionTokens: 0.13,
	},
	local: {
		id: "local",
		label: "Local OpenAI-compatible embeddings",
		baseUrl: "http://127.0.0.1:11434/v1/embeddings",
		model: "nomic-embed-text",
		embeddingDim: undefined,
		pricePerMillionTokens: 0,
	},
	custom: {
		id: "custom",
		label: "Custom OpenAI-compatible embeddings",
		baseUrl: "https://api.voyageai.com/v1/embeddings",
		model: "voyage-code-3",
		apiKeyEnv: "VOYAGE_API_KEY",
		embeddingDim: 1024,
		pricePerMillionTokens: 0.12,
	},
};

export const DEFAULT_EXCLUDE_DIRS = [
	".git",
	CONFIG_DIR_NAME,
	"node_modules",
	"dist",
	"build",
	"target",
	".venv",
	"venv",
	"vendor",
	".next",
	".cache",
	"coverage",
	".turbo",
	".pnpm-store",
	"__pycache__",
	".pytest_cache",
	".ruff_cache",
	".mypy_cache",
	".omc",
	".omo",
	".omx",
	".kilo",
	".codegraph",
	".playwright-mcp",
];

export const DEFAULT_CONFIG: GlobalConfig = {
	provider: "voyage",
	batchSize: 32,
	requestConcurrency: 2,
	timeoutMs: 45_000,
	chunkLines: 80,
	chunkOverlap: 20,
	maxFileBytes: 768 * 1024,
	maxChunkChars: 12_000,
	watcherDebounceMs: 1000,
	watcherBulkThreshold: 50,
	largeRepoConfirmChunks: 5000,
	annIndexThreshold: 50_000,
	maxTopK: 50,
	// Minimum similarity (score = 1/(1+distance), range (0,1]) for a result to be returned; 0 = off.
	// Borrowed from claude-context's 0.5 cutoff — trims low-relevance noise, does NOT raise recall.
	scoreThreshold: 0,
	// Chars of the preceding chunk folded into each chunk's EMBEDDED text for cross-boundary context
	// (agent-facing content + line range stay exact); 0 = off. A/B test via eval before enabling.
	chunkOverlapChars: 0,
	excludeDirs: DEFAULT_EXCLUDE_DIRS,
};

// Single source of truth for the scalar fields that change the STORED vectors. Both the settings UI
// (which prompts "reindex") and manifestCompatible (which enforces staleness) derive from this list,
// so the "asks you to reindex" set and the "detects stale" set can never drift apart.
export const INDEX_AFFECTING_KEYS = ["maxChunkChars", "chunkOverlapChars", "chunkLines", "chunkOverlap", "maxFileBytes"] as const;

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

export async function loadGlobalConfig(): Promise<GlobalConfig> {
	await mkdir(DATA_DIR, { recursive: true });
	const existing = await readJson<Partial<GlobalConfig>>(GLOBAL_CONFIG_PATH);
	if (!existing) {
		await writeJson(GLOBAL_CONFIG_PATH, DEFAULT_CONFIG);
		return { ...DEFAULT_CONFIG };
	}
	const merged = { ...DEFAULT_CONFIG, ...existing };
	return merged;
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
	const sanitized = { ...config } as Record<string, unknown>;
	delete sanitized.apiKey;
	await writeJson(GLOBAL_CONFIG_PATH, sanitized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPiAuthData(): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(AUTH_FILE_PATH, "utf8"));
		if (!isRecord(parsed)) throw new Error("pi auth.json must contain an object");
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export async function loadStoredApiKey(provider: ProviderId): Promise<string | undefined> {
	const authData = await readPiAuthData();
	const entry = authData[`code-index-${provider}`];
	if (!isRecord(entry) || typeof entry.key !== "string") return undefined;
	return entry.key.trim() || undefined;
}

export async function saveStoredApiKey(provider: ProviderId, key: string | undefined): Promise<void> {
	const authData = await readPiAuthData();
	const id = `code-index-${provider}`;
	if (key?.trim()) {
		authData[id] = { type: "api_key", key: key.trim() };
	} else {
		delete authData[id];
	}
	await mkdir(dirname(AUTH_FILE_PATH), { recursive: true, mode: 0o700 });
	await writeFile(AUTH_FILE_PATH, `${JSON.stringify(authData, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(AUTH_FILE_PATH, 0o600);
}

export async function loadProjectState(project: ProjectInfo): Promise<ProjectState> {
	return (await readJson<ProjectState>(project.statePath)) ?? { enabled: false };
}

export async function saveProjectState(project: ProjectInfo, state: ProjectState): Promise<void> {
	await mkdir(join(project.statePath, ".."), { recursive: true });
	const sanitized = { ...state } as Record<string, unknown>;
	delete sanitized.apiKey;
	await writeFile(project.statePath, `${JSON.stringify(sanitized, null, "\t")}\n`, "utf8");
}

export async function resolveConfig(project: ProjectInfo): Promise<{ global: GlobalConfig; project: ProjectState; resolved: ResolvedConfig }> {
	const global = await loadGlobalConfig();
	const projectState = await loadProjectState(project);
	const provider = (global.provider ?? "voyage") as ProviderId;
	const preset = PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS.voyage;
	const baseUrl = projectState.baseUrl ?? global.baseUrl ?? preset.baseUrl;
	const model = projectState.model ?? global.model ?? preset.model;
	const apiKeyEnv = projectState.apiKeyEnv ?? global.apiKeyEnv ?? preset.apiKeyEnv;
	const apiKey =
		provider === "local"
			? undefined
			: (apiKeyEnv ? process.env[apiKeyEnv]?.trim() : undefined) || (await loadStoredApiKey(provider));
	const pricePerMillionTokens = global.pricePerMillionTokens ?? preset.pricePerMillionTokens;
	return {
		global,
		project: projectState,
		resolved: {
			...global,
			excludeDirs: projectState.excludeDirs ?? global.excludeDirs,
			chunkLines: projectState.chunkLines ?? global.chunkLines,
			chunkOverlap: projectState.chunkOverlap ?? global.chunkOverlap,
			maxFileBytes: projectState.maxFileBytes ?? global.maxFileBytes,
			providerPreset: preset,
			baseUrl,
			model,
			apiKeyEnv,
			apiKeyPresent: Boolean(apiKey) || provider === "local",
			apiKey,
			embeddingDim: global.embeddingDim ?? preset.embeddingDim,
			pricePerMillionTokens,
		},
	};
}
