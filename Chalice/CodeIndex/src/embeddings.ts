import type { ResolvedConfig } from "./types.ts";

export class EmbeddingError extends Error {}

// Voyage supports asymmetric encoding: index chunks as "document", encode searches as "query".
// Other OpenAI-compatible providers reject the field, so it is only sent for the voyage provider.
export type InputType = "document" | "query";

export interface EmbeddingResult {
	vectors: number[][];
	dimension: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					reject(new Error("aborted"));
				},
				{ once: true },
			);
		}
	});
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) break;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function postEmbeddings(config: ResolvedConfig, input: string[], signal: AbortSignal | undefined, inputType: InputType | undefined): Promise<EmbeddingResult> {
	if (!config.apiKeyPresent && config.provider !== "local") {
		throw new EmbeddingError(`Missing API key env ${config.apiKeyEnv ?? "(unset)"} for ${config.provider}`);
	}
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
	const body: Record<string, unknown> = { model: config.model, input };
	if (inputType && config.provider === "voyage") body.input_type = inputType;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
	if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
	try {
		const res = await fetch(config.baseUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await res.text();
		if (!res.ok) throw new EmbeddingError(`Embedding request failed (${res.status}): ${text.slice(0, 500)}`);
		const json = JSON.parse(text) as { data?: Array<{ embedding?: number[] }> };
		const vectors = json.data?.map((d) => d.embedding).filter((v): v is number[] => Array.isArray(v)) ?? [];
		if (vectors.length !== input.length) throw new EmbeddingError(`Embedding response count mismatch: got ${vectors.length}, expected ${input.length}`);
		const dimension = vectors[0]?.length ?? 0;
		if (!dimension) throw new EmbeddingError("Embedding response contained empty vectors");
		if (!vectors.every((v) => v.length === dimension)) throw new EmbeddingError("Embedding response contained mixed dimensions");
		if (config.embeddingDim && dimension !== config.embeddingDim) {
			throw new EmbeddingError(`Embedding dimension mismatch for ${config.model}: got ${dimension}, expected ${config.embeddingDim}`);
		}
		return { vectors, dimension };
	} finally {
		clearTimeout(timeout);
	}
}

export async function embedBatch(config: ResolvedConfig, input: string[], signal: AbortSignal | undefined, inputType: InputType | undefined): Promise<EmbeddingResult> {
	let last: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await postEmbeddings(config, input, signal, inputType);
		} catch (error) {
			last = error;
			if (signal?.aborted) throw error;
			if (attempt < 2) await sleep(750 * 2 ** attempt, signal);
		}
	}
	throw last instanceof Error ? last : new EmbeddingError(String(last));
}

export async function embedTexts(config: ResolvedConfig, texts: string[], signal?: AbortSignal, inputType?: InputType, onProgress?: (done: number, total: number) => void): Promise<EmbeddingResult> {
	if (texts.length === 0) return { vectors: [], dimension: config.embeddingDim ?? 0 };
	const batches: string[][] = [];
	for (let i = 0; i < texts.length; i += config.batchSize) batches.push(texts.slice(i, i + config.batchSize));
	let done = 0;
	const batchResults = await mapWithConcurrency(batches, config.requestConcurrency, async (batch) => {
		const result = await embedBatch(config, batch, signal, inputType);
		done += batch.length;
		onProgress?.(done, texts.length);
		return result;
	});
	const vectors: number[][] = [];
	let dimension = config.embeddingDim ?? 0;
	for (const result of batchResults) {
		if (dimension && result.dimension !== dimension) throw new EmbeddingError(`Embedding dimension changed: got ${result.dimension}, expected ${dimension}`);
		dimension = result.dimension;
		vectors.push(...result.vectors);
	}
	return { vectors, dimension };
}
