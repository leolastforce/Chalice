import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type SupportedApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "anthropic-message"
  | "mistral-conversations"
  | "google-generative-ai"
  | "google-vertex"
  | "azure-openai-responses"
  | (string & {});

export interface ModelOverride {
  [key: string]: unknown;
  name?: string;
  api?: SupportedApi;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    tiers?: Array<{
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>;
  };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  samplingParams?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

export interface ModelConfigEntry extends ModelOverride {
  id: string;
}

export interface CustomProviderConfig extends ModelOverride {
  id: string;
  apiKey?: string;
  models: ModelConfigEntry[];
}

export interface CustomProvidersConfig {
  providers: CustomProviderConfig[];
}

export type ConfigWarnings = string[];

export const DEFAULT_CONFIG: CustomProvidersConfig = { providers: [] };

const MODELS_FILE = "models.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function modelOverride(value: unknown): ModelOverride {
  if (!isRecord(value)) return {};
  const result = { ...value } as ModelOverride;
  if (nonEmptyString(value.api)) result.api = normalizeApi(value.api);
  return result;
}

export function mergeModelConfig(
  provider: CustomProviderConfig,
  model: ModelOverride,
): ModelOverride {
  const {
    id: _id,
    apiKey: _apiKey,
    models: _models,
    ...providerDefaults
  } = provider;
  return {
    ...providerDefaults,
    ...model,
    ...(provider.cost || model.cost
      ? { cost: { ...provider.cost, ...model.cost } }
      : {}),
    ...(provider.headers || model.headers
      ? { headers: { ...provider.headers, ...model.headers } }
      : {}),
    ...(provider.samplingParams || model.samplingParams
      ? {
          samplingParams: {
            ...provider.samplingParams,
            ...model.samplingParams,
          },
        }
      : {}),
    ...(provider.compat || model.compat
      ? { compat: { ...provider.compat, ...model.compat } }
      : {}),
    ...(provider.thinkingLevelMap || model.thinkingLevelMap
      ? {
          thinkingLevelMap: {
            ...provider.thinkingLevelMap,
            ...model.thinkingLevelMap,
          },
        }
      : {}),
  };
}

export function normalizeApi(value: string): SupportedApi {
  return value === "anthropic-message" ? "anthropic-messages" : value;
}

function normalizeProvider(
  value: unknown,
  providerId: string,
): CustomProviderConfig | undefined {
  if (!isRecord(value)) return undefined;
  const models =
    value.models === undefined ? [] : (value.models as ModelConfigEntry[]);
  return {
    ...modelOverride(value),
    id: providerId,
    models,
  };
}

export function normalizeConfig(
  raw: unknown,
  providerId = "provider",
): { config: CustomProvidersConfig; warnings: ConfigWarnings } {
  const warnings: ConfigWarnings = [];
  if (raw === undefined || raw === null)
    return { config: DEFAULT_CONFIG, warnings };
  const provider = normalizeProvider(raw, providerId);
  return {
    config: provider ? { providers: [provider] } : DEFAULT_CONFIG,
    warnings,
  };
}

async function readModelsFile(
  path: string,
): Promise<{ raw: unknown; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { raw: undefined };
    throw error;
  }
  try {
    return { raw: text.trim() ? (JSON.parse(text) as unknown) : undefined };
  } catch (error) {
    const message =
      error instanceof SyntaxError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      raw: undefined,
      warning: `models.json: invalid JSON (${message})`,
    };
  }
}

export async function loadConfig(
  agentDir: string,
): Promise<{ config: CustomProvidersConfig; warnings: ConfigWarnings }> {
  const warnings: ConfigWarnings = [];
  const { raw, warning } = await readModelsFile(join(agentDir, MODELS_FILE));
  if (warning) warnings.push(warning);
  if (raw === undefined || raw === null)
    return { config: DEFAULT_CONFIG, warnings };
  if (!isRecord(raw) || !isRecord(raw.providers))
    return { config: DEFAULT_CONFIG, warnings };
  const providers = Object.entries(raw.providers)
    .map(([id, value]) => normalizeProvider(value, id))
    .filter(
      (provider): provider is CustomProviderConfig => provider !== undefined,
    );
  return { config: { providers }, warnings };
}
