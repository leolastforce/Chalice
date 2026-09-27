export type ProviderId = "voyage" | "openrouter" | "local" | "custom";

export interface ProviderPreset {
	id: ProviderId;
	label: string;
	baseUrl: string;
	model: string;
	apiKeyEnv?: string;
	embeddingDim?: number;
	pricePerMillionTokens?: number;
}

export interface GlobalConfig {
	provider: ProviderId;
	baseUrl?: string;
	model?: string;
	apiKeyEnv?: string;
	embeddingDim?: number;
	batchSize: number;
	requestConcurrency: number;
	timeoutMs: number;
	chunkLines: number;
	chunkOverlap: number;
	maxFileBytes: number;
	maxChunkChars: number;
	watcherDebounceMs: number;
	watcherBulkThreshold: number;
	largeRepoConfirmChunks: number;
	pricePerMillionTokens?: number;
	annIndexThreshold: number;
	maxTopK: number;
	scoreThreshold: number;
	chunkOverlapChars: number;
	excludeDirs: string[];
}

export interface ProjectState {
	enabled: boolean;
	model?: string;
	baseUrl?: string;
	apiKeyEnv?: string;
	excludeDirs?: string[];
	chunkLines?: number;
	chunkOverlap?: number;
	maxFileBytes?: number;
	lastIndexedAt?: string;
	lastError?: string;
	dataEgressConfirmed?: boolean;
}

export interface ResolvedConfig extends GlobalConfig {
	providerPreset: ProviderPreset;
	baseUrl: string;
	model: string;
	apiKeyEnv?: string;
	apiKeyPresent: boolean;
	apiKey?: string;
}

export interface ProjectInfo {
	cwd: string;
	root: string;
	hash: string;
	statePath: string;
	indexDir: string;
	manifestPath: string;
	safe: boolean;
	reason?: string;
}

export interface SourceFile {
	path: string;
	absPath: string;
	language: string;
	content: string;
	size: number;
	mtimeMs: number;
	fileHash: string;
}

export interface CodeChunk {
	id: string;
	projectRoot: string;
	path: string;
	language: string;
	symbol?: string;
	startLine: number;
	endLine: number;
	content: string;
	embeddedText: string;
	contentHash: string;
	fileHash: string;
	mtimeMs: number;
	size: number;
	vector?: number[];
}

export interface ManifestFileEntry {
	path: string;
	fileHash: string;
	mtimeMs: number;
	size: number;
	chunkIds: string[];
}

export interface Manifest {
	version: number;
	projectRoot: string;
	baseUrl: string;
	model: string;
	embeddingDim: number;
	indexParams?: Record<string, number>;
	createdAt: string;
	updatedAt: string;
	chunkCount: number;
	fileCount: number;
	annIndexBuilt?: boolean;
	files: Record<string, ManifestFileEntry>;
}

export interface IndexEstimate {
	files: number;
	chunks: number;
	estimatedTokens: number;
	estimatedCost?: number;
	model: string;
	baseUrl: string;
}

export type FooterState = "off" | "not-indexed" | "indexing" | "ready" | "stale" | "error" | "bulk-pending";

export interface RuntimeStatus {
	state: FooterState;
	message?: string;
	filesDone?: number;
	filesTotal?: number;
	chunks?: number;
	lastError?: string;
}

// Bumped to 2: chunk embeddedText format changed (line numbers moved out of the embedded text, so
// contentHash is now content-stable). Existing v1 indexes are reported stale and prompt a reindex.
export const INDEX_VERSION = 2;
