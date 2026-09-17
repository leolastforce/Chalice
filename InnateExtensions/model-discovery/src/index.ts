import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type DiscoveredModel, listModels, mapModel } from "./api";
import {
  type ConfigWarnings,
  type CustomProviderConfig,
  loadConfig,
  mergeModelConfig,
} from "./config";

function modelConfig(model: DiscoveredModel): ProviderModelConfig {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap
      ? { thinkingLevelMap: model.thinkingLevelMap }
      : {}),
    ...(model.headers ? { headers: model.headers } : {}),
    ...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  } as ProviderModelConfig;
}

function providerModels(
  provider: CustomProviderConfig,
): CustomProviderConfig["models"] {
  return Array.isArray(provider.models)
    ? provider.models.filter(
        (entry) =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
}

function configuredModels(provider: CustomProviderConfig): DiscoveredModel[] {
  return providerModels(provider)
    .map((entry) => {
      const { id, ...override } = entry;
      const merged = mergeModelConfig(provider, override);
      return mapModel(provider, {
        id,
        ...merged,
        cost: {
          input: merged.cost?.input ?? 0,
          output: merged.cost?.output ?? 0,
          cacheRead: merged.cost?.cacheRead ?? 0,
          cacheWrite: merged.cost?.cacheWrite ?? 0,
        },
      });
    })
    .filter((model): model is DiscoveredModel => model !== undefined);
}

export function mergeModels(
  discovered: DiscoveredModel[],
  provider: CustomProviderConfig,
): DiscoveredModel[] {
  const configured = configuredModels(provider);
  const configuredById = new Map(
    providerModels(provider).map((entry) => [entry.id, entry]),
  );
  const discoveredIds = new Set(discovered.map((model) => model.id));
  const merged = discovered.map((model) => {
    const override = configuredById.get(model.id);
    if (!override) return model;
    return (
      mapModel(provider, {
        ...model,
        ...mergeModelConfig(provider, {
          ...override,
          cost: { ...model.cost, ...override.cost },
        }),
      }) ?? model
    );
  });
  return [
    ...merged,
    ...configured.filter((model) => !discoveredIds.has(model.id)),
  ];
}

function warningsMessage(warnings: ConfigWarnings): string {
  return warnings.length > 0
    ? `\nConfiguration warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
    : "";
}

function usage(): string {
  return [
    "Usage: /model-discovery <subcommand>",
    "",
    "  status                 Show configured providers and model counts",
    "  refresh                Refresh all provider model catalogs",
    "  refresh <provider>     Refresh one provider model catalog",
  ].join("\n");
}

async function refreshProvider(
  provider: CustomProviderConfig,
  ctx: ExtensionCommandContext,
): Promise<DiscoveredModel[]> {
  try {
    const discovered = await listModels(provider, ctx.signal);
    return mergeModels(discovered, provider);
  } catch (error) {
    if (configuredModels(provider).length > 0)
      return configuredModels(provider);
    throw error;
  }
}

export default async function piCustomProvidersExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const { config, warnings } = await loadConfig(getAgentDir());
  const catalogs = new Map<string, DiscoveredModel[]>();

  const register = (
    provider: CustomProviderConfig,
    models: DiscoveredModel[],
  ): void => {
    const baseUrl =
      typeof provider.baseUrl === "string" && provider.baseUrl.trim().length > 0
        ? provider.baseUrl
        : undefined;
    catalogs.set(provider.id, baseUrl ? models : []);
    if (!baseUrl) return;
    pi.registerProvider(provider.id, {
      name: provider.name ?? provider.id,
      baseUrl,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.api ? { api: provider.api } : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
      ...(provider.compat ? { compat: provider.compat } : {}),
      models: models.map(modelConfig),
    });
  };

  const offline =
    process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true";
  await Promise.all(
    config.providers.map(async (provider) => {
      let models = configuredModels(provider);
      if (!offline) {
        try {
          const discovered = await listModels(provider);
          models = mergeModels(discovered, provider);
        } catch {
          // Configured models remain available when discovery is unavailable.
        }
      }
      register(provider, models);
      return undefined;
    }),
  );

  pi.registerCommand("model-discovery", {
    description: "Manage configurable custom providers and model catalogs.",
    getArgumentCompletions: (prefix: string) =>
      [
        "status",
        "refresh",
        ...config.providers.map((provider) => provider.id),
      ].flatMap((value) =>
        value.startsWith(prefix) ? [{ value, label: value }] : [],
      ),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [subcommand, providerId] = args.trim().split(/\s+/).filter(Boolean);
      if (!subcommand || subcommand === "help") {
        ctx.ui.notify(usage(), "info");
        return;
      }
      if (subcommand === "status") {
        ctx.ui.notify(
          config.providers
            .map(
              (provider) =>
                `${provider.id}: ${catalogs.get(provider.id)?.length ?? 0} models`,
            )
            .join("\n") || "No custom providers configured.",
          "info",
        );
        return;
      }
      if (subcommand === "refresh") {
        const providers = providerId
          ? config.providers.filter((provider) => provider.id === providerId)
          : config.providers;
        if (providers.length === 0) {
          ctx.ui.notify(`Unknown provider: ${providerId}`, "warning");
          return;
        }
        const results = await Promise.allSettled(
          providers.map(async (provider) => {
            const models = await refreshProvider(provider, ctx);
            register(provider, models);
            return `${provider.id}: loaded ${models.length} models`;
          }),
        );
        ctx.ui.notify(
          results
            .map((result) =>
              result.status === "fulfilled"
                ? result.value
                : `refresh failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
            )
            .join("\n"),
          results.some((result) => result.status === "rejected")
            ? "warning"
            : "info",
        );
        return;
      }
      ctx.ui.notify(usage(), "warning");
    },
  });

  if (warnings.length > 0) {
    pi.on(
      "session_start",
      async (
        _event: unknown,
        ctx: {
          ui: {
            notify: (
              message: string,
              type?: "info" | "warning" | "error",
            ) => void;
          };
        },
      ) => {
        ctx.ui.notify(warningsMessage(warnings), "warning");
      },
    );
  }
}

export { listModels, mapModel } from "./api";
export type {
  CustomProviderConfig,
  CustomProvidersConfig,
  ModelOverride,
  SupportedApi,
} from "./config";
export { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "./config";
