import { execSync } from "node:child_process";
import {
  type CustomProviderConfig,
  type ModelOverride,
  mergeModelConfig,
  normalizeApi,
  type SupportedApi,
} from "./config";

export interface DiscoveredModel {
  id: string;
  name: string;
  api: SupportedApi;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface ServerModel {
  id?: string;
  model?: string;
  name?: string;
  api?: string;
  api_type?: string;
  baseUrl?: string;
  base_url?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  modalities?: string[];
  contextWindow?: number;
  context_window?: number;
  maxTokens?: number;
  max_tokens?: number;
  max_output_tokens?: number;
  cost?: Partial<DiscoveredModel["cost"]>;
  pricing?: Record<string, number | string>;
  samplingParams?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  [key: string]: unknown;
}

function resolveConfigValue(value: string): string | undefined {
  if (value.startsWith("!")) {
    try {
      return execSync(value.slice(1), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  }
  let resolved = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "$") {
      resolved += value[index];
      index += 1;
      continue;
    }
    if (value[index + 1] === "$" || value[index + 1] === "!") {
      resolved += value[index + 1];
      index += 2;
      continue;
    }
    const rest = value.slice(index);
    const braced = rest.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
    const plain = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
    const name = braced?.[1] ?? plain?.[1];
    if (!name) {
      resolved += "$";
      index += 1;
      continue;
    }
    const envValue = process.env[name];
    if (envValue === undefined) return undefined;
    resolved += envValue;
    index += (braced ?? plain)?.[0].length ?? 1;
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPositiveNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function asCost(value: unknown): DiscoveredModel["cost"] {
  const record = isRecord(value) ? value : {};
  const pricing = isRecord(record.pricing) ? record.pricing : record;
  const read = (key: string): number => {
    const value = pricing[key];
    const parsed = typeof value === "string" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
  };
  const tiers = Array.isArray(pricing.tiers)
    ? pricing.tiers.filter(isRecord).flatMap((tier) => {
        const inputTokensAbove = asPositiveNumber(tier.inputTokensAbove);
        const input = asNonNegativeNumber(tier.input);
        const output = asNonNegativeNumber(tier.output);
        const cacheRead = asNonNegativeNumber(tier.cacheRead);
        const cacheWrite = asNonNegativeNumber(tier.cacheWrite);
        return inputTokensAbove !== undefined &&
          input !== undefined &&
          output !== undefined &&
          cacheRead !== undefined &&
          cacheWrite !== undefined
          ? [{ inputTokensAbove, input, output, cacheRead, cacheWrite }]
          : [];
      })
    : undefined;
  return {
    input: read("input") || read("input_token") || read("prompt"),
    output: read("output") || read("output_token") || read("completion"),
    cacheRead: read("cacheRead") || read("cache_read"),
    cacheWrite: read("cacheWrite") || read("cache_write"),
    ...(tiers && tiers.length > 0 ? { tiers } : {}),
  };
}

function normalizeInput(value: unknown): ("text" | "image")[] {
  if (Array.isArray(value)) {
    const input = value.flatMap((item) => {
      if (typeof item !== "string") return [];
      const lower = item.toLowerCase();
      return lower.includes("image")
        ? ["image" as const]
        : lower.includes("text")
          ? ["text" as const]
          : [];
    });
    if (input.length > 0) return [...new Set(input)];
  }
  return ["text"];
}

function inferApi(
  provider: CustomProviderConfig,
  server: ServerModel,
  config: ModelOverride,
): SupportedApi {
  const value = config.api ?? server.api ?? server.api_type;
  if (typeof value === "string" && value.length > 0) return normalizeApi(value);
  return typeof provider.api === "string" && provider.api.length > 0
    ? normalizeApi(provider.api)
    : "openai-completions";
}

export function mapModel(
  provider: CustomProviderConfig,
  server: ServerModel,
): DiscoveredModel | undefined {
  const rawId = server.id ?? server.model;
  const id = typeof rawId === "string" ? rawId.trim() : undefined;
  if (!id) return undefined;
  const configuredModel = Array.isArray(provider.models)
    ? provider.models.find((model) => isRecord(model) && model.id === id)
    : undefined;
  const config = mergeModelConfig(provider, configuredModel ?? {});
  const api = inferApi(provider, server, config);
  const contextWindow =
    asPositiveNumber(
      config.contextWindow,
      server.contextWindow,
      server.context_window,
    ) ?? 128000;
  const maxTokens =
    asPositiveNumber(
      config.maxTokens,
      server.maxTokens,
      server.max_output_tokens,
      server.max_tokens,
    ) ?? 16384;
  const baseUrlValue =
    config.baseUrl ??
    (typeof server.baseUrl === "string" ? server.baseUrl : server.base_url) ??
    provider.baseUrl;
  const baseUrl =
    typeof baseUrlValue === "string" && baseUrlValue.trim().length > 0
      ? baseUrlValue.trim().replace(/\/$/, "")
      : undefined;
  if (!baseUrl) return undefined;
  const cost = { ...asCost(server.cost ?? server.pricing), ...config.cost };
  return {
    id,
    name: config.name ?? server.name ?? id,
    api,
    baseUrl,
    reasoning:
      config.reasoning ??
      server.reasoning ??
      /reason|thinking|deepseek|o[1-9]|claude/i.test(id),
    input: config.input ?? normalizeInput(server.input ?? server.modalities),
    cost: {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cacheRead ?? 0,
      cacheWrite: cost.cacheWrite ?? 0,
    },
    contextWindow,
    maxTokens,
    ...((config.thinkingLevelMap ?? server.thinkingLevelMap)
      ? { thinkingLevelMap: config.thinkingLevelMap ?? server.thinkingLevelMap }
      : {}),
    ...((config.headers ?? server.headers)
      ? { headers: { ...server.headers, ...config.headers } }
      : {}),
    ...((config.samplingParams ?? server.samplingParams)
      ? {
          samplingParams: {
            ...server.samplingParams,
            ...config.samplingParams,
          },
        }
      : {}),
    ...((config.compat ?? server.compat)
      ? { compat: { ...server.compat, ...config.compat } }
      : {}),
  };
}

function modelArray(body: unknown): ServerModel[] {
  if (Array.isArray(body)) return body.filter(isRecord) as ServerModel[];
  if (!isRecord(body)) return [];
  const candidates = [
    body.data,
    body.models,
    isRecord(body.output) ? body.output.models : undefined,
  ];
  return (
    (candidates.find(Array.isArray)?.filter(isRecord) as
      | ServerModel[]
      | undefined) ?? []
  );
}

const MODELS_PATH = "/models";

export async function listModels(
  provider: CustomProviderConfig,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const baseUrl =
    typeof provider.baseUrl === "string" && provider.baseUrl.trim().length > 0
      ? provider.baseUrl.trim().replace(/\/$/, "")
      : undefined;
  if (!baseUrl) return [];
  const apiKey =
    typeof provider.apiKey === "string"
      ? resolveConfigValue(provider.apiKey)
      : undefined;
  if (!apiKey)
    throw new Error(`API key for provider ${provider.id} is not configured`);
  const response = await fetch(`${baseUrl}${MODELS_PATH}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok)
    throw new Error(
      `${response.status} ${response.statusText}: ${typeof body === "string" ? body : "request failed"}`,
    );
  return modelArray(body)
    .map((model) => mapModel(provider, model))
    .filter((model): model is DiscoveredModel => model !== undefined);
}
