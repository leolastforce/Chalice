import { Spacer, Text } from "@earendil-works/pi-tui";

const UPDATE_LIST_PATCH = Symbol.for("pi-model-selector-x:update-list-patch");
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const APIKEY_CACHE = Symbol.for("pi-model-selector-x:apikey-cache");

// ── API key masking ──

function maskApiKey(key) {
	if (!key || typeof key !== "string") return null;
	const k = key.trim();
	if (k.length === 0) return null;
	if (k.length <= 8) return "*".repeat(k.length);
	const head = k.slice(0, 6);
	const tail = k.slice(-4);
	return `${head}…${tail}`;
}

function getApiKeyCache(selector) {
	let cache = selector[APIKEY_CACHE];
	if (!cache) {
		cache = new Map();
		selector[APIKEY_CACHE] = cache;
	}
	return cache;
}

function resolveApiKeyDisplay(selector, model) {
	// pi >= 0.85 moved model access from ModelRegistry to ModelRuntime.
	// The selector now owns modelRuntime directly, while older releases exposed
	// modelRegistry. Support both shapes so the extension remains backwards compatible.
	const registry = selector.modelRegistry ?? selector.modelRuntime;
	if (!registry?.getApiKeyAndHeaders && !registry?.getAuth) return null;
	const cache = getApiKeyCache(selector);
	const key = `${model.provider}:${model.id}`;
	if (cache.has(key)) return cache.get(key);

	cache.set(key, { state: "loading" });
	Promise.resolve()
		.then(async () => {
			if (registry.getApiKeyAndHeaders) return registry.getApiKeyAndHeaders(model);
			try {
				const resolution = await registry.getAuth(model);
				return resolution
					? { ok: true, apiKey: resolution.auth?.apiKey, headers: resolution.auth?.headers }
					: { ok: true };
			} catch (err) {
				return { ok: false, error: err?.message || String(err) };
			}
		})
		.then((result) => {
			if (result?.ok && result.apiKey) {
				cache.set(key, { state: "ok", masked: maskApiKey(result.apiKey), len: result.apiKey.length });
			} else if (result?.ok) {
				cache.set(key, { state: "none" });
			} else {
				cache.set(key, { state: "error", error: result?.error || "unknown" });
			}
			selector.tui?.requestRender?.();
		})
		.catch((err) => {
			cache.set(key, { state: "error", error: err?.message || String(err) });
			selector.tui?.requestRender?.();
		});
	return { state: "loading" };
}

// ── Theme ──

function getTheme() {
	return globalThis[THEME_KEY];
}

// ── Formatters ──

function formatContextWindow(tokens) {
	if (!tokens) return null;
	if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

function formatMaxTokens(tokens) {
	if (!tokens) return null;
	if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

function formatCostNum(value) {
	if (!value) return "0";
	if (value < 0.01) return value.toFixed(3);
	if (value < 1) return value.toFixed(2);
	if (value < 10) return value.toFixed(1);
	return Math.round(value).toString();
}

function formatCost(cost) {
	if (!cost) return null;
	const { input, output } = cost;
	if (!input && !output) return { label: "free", isFree: true };
	return {
		label: `$${formatCostNum(input)} / $${formatCostNum(output)}`,
		isFree: false,
	};
}

function formatInputShort(input) {
	if (!input || input.length === 0) return "txt";
	const parts = [];
	if (input.includes("text")) parts.push("txt");
	if (input.includes("image")) parts.push("img");
	if (input.includes("audio")) parts.push("aud");
	return parts.join("+") || "txt";
}

function formatProtocolShort(api) {
	if (!api) return null;
	const map = {
		"openai-responses": "resp",
		"openai-completions": "comp",
		"anthropic-messages": "anth",
	};
	return map[api] || api.slice(0, 5);
}

// ── Patched updateList ──

function appendDetailPane(selector) {
	const theme = getTheme();
	if (!theme) return;

	const selected = selector.filteredModels?.[selector.selectedIndex];
	if (!selected) return;

	const model = selected.model;
	const providerId = selected.provider;
	const apiProtocol = model.api || null;

	// Separator
	selector.listContainer.addChild(new Spacer(1));
	selector.listContainer.addChild(new Text(theme.fg("border", "  " + "─".repeat(50)), 0, 0));
	selector.listContainer.addChild(new Spacer(0));

	// Model full name + provider
	const fullName = model.name || model.id;
	selector.listContainer.addChild(
		new Text(
			`  ${theme.bold(theme.fg("accent", fullName))}` + theme.fg("muted", `  [${providerId}]`),
			0,
			0,
		),
	);

	// Line 1: Context · Max Output · Protocol · Input · Reasoning
	const line1Parts = [];

	if (model.contextWindow) {
		line1Parts.push(theme.fg("muted", "Context ") + theme.fg("accent", formatContextWindow(model.contextWindow)));
	}
	if (model.maxTokens) {
		line1Parts.push(theme.fg("muted", "MaxOut ") + theme.fg("muted", formatMaxTokens(model.maxTokens)));
	}
	if (apiProtocol) {
		line1Parts.push(theme.fg("muted", "API ") + theme.fg("accent", formatProtocolShort(apiProtocol)));
	}
	if (model.input) {
		line1Parts.push(theme.fg("muted", "Input ") + theme.fg("muted", formatInputShort(model.input)));
	}
	if (model.reasoning) {
		line1Parts.push(theme.fg("warning", "⚡ reasoning"));
	}

	if (line1Parts.length > 0) {
		selector.listContainer.addChild(new Text(`  ${line1Parts.join(theme.fg("muted", "  ·  "))}`, 0, 0));
	}

	// Line 2: Cost
	const costInfo = formatCost(model.cost);
	if (costInfo) {
		const costColor = costInfo.isFree ? "success" : "muted";
		let costLine = theme.fg("muted", "Cost ") + theme.fg(costColor, costInfo.label);

		if (model.cost?.cacheRead) {
			costLine += theme.fg("muted", "  ·  cache read ") + theme.fg("muted", `$${formatCostNum(model.cost.cacheRead)}`);
		}
		if (model.cost?.cacheWrite) {
			costLine += theme.fg("muted", "  ·  cache write ") + theme.fg("muted", `$${formatCostNum(model.cost.cacheWrite)}`);
		}

		selector.listContainer.addChild(new Text(`  ${costLine}`, 0, 0));
	}

	if (model.baseUrl) {
		selector.listContainer.addChild(
			new Text(theme.fg("muted", "  BaseURL ") + theme.fg("muted", model.baseUrl), 0, 0),
		);
	}

	// Line: masked API key for quick visual identification
	const keyInfo = resolveApiKeyDisplay(selector, { ...model, provider: providerId, id: model.id });
	if (keyInfo) {
		let keyLine;
		switch (keyInfo.state) {
			case "loading":
				keyLine = theme.fg("muted", "  APIKey  ") + theme.fg("muted", "…");
				break;
			case "ok":
				keyLine =
					theme.fg("muted", "  APIKey  ") +
					theme.fg("accent", keyInfo.masked) +
					theme.fg("muted", `  (${keyInfo.len} chars)`);
				break;
			case "none":
				keyLine = theme.fg("muted", "  APIKey  ") + theme.fg("warning", "not configured");
				break;
			case "error":
				keyLine = theme.fg("muted", "  APIKey  ") + theme.fg("error", keyInfo.error);
				break;
			default:
				keyLine = null;
		}
		if (keyLine) {
			selector.listContainer.addChild(new Text(keyLine, 0, 0));
		}
	}
}

// ── Patch / Unpatch ──

export function installModelSelectorXPatches(ModelSelectorComponent) {
	const proto = ModelSelectorComponent.prototype;
	uninstallModelSelectorXPatches(ModelSelectorComponent);

	const originalUpdateList = proto.updateList;
	const patchedUpdateList = function enhancedUpdateList() {
		originalUpdateList.call(this);
		try {
			appendDetailPane(this);
		} catch {
			// Silent — enhancement failure must not break the selector
		}
	};

	proto.updateList = patchedUpdateList;
	proto[UPDATE_LIST_PATCH] = {
		original: originalUpdateList,
		patched: patchedUpdateList,
	};
	return () => uninstallModelSelectorXPatches(ModelSelectorComponent);
}

function uninstallModelSelectorXPatches(ModelSelectorComponent) {
	const proto = ModelSelectorComponent.prototype;
	const patch = proto[UPDATE_LIST_PATCH];
	if (!patch) return;

	if (proto.updateList === patch.patched) {
		proto.updateList = patch.original;
	}
	delete proto[UPDATE_LIST_PATCH];
}
