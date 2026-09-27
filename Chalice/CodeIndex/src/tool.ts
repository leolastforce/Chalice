import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { embedTexts } from "./embeddings.ts";
import { resolveConfig } from "./config.ts";
import { getProjectInfo } from "./project.ts";
import { loadManifest, manifestCompatible, searchIndex } from "./store.ts";
import { buildTagResolver, computeTagStats, EMPTY_TAGS_HELP, formatDeclaredTags, listDeclaredTags, matchesTagFilter, normalizeTag } from "./tagging.ts";

function snippet(content: string): string {
	const lines = content.trim().split(/\r?\n/).slice(0, 8);
	return lines.map((l) => `   ${l.length > 180 ? `${l.slice(0, 177)}...` : l}`).join("\n");
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function matchesFilters(path: string, params: { path?: string; include?: string[]; exclude?: string[] }): boolean {
	if (params.path && !path.startsWith(params.path)) return false;
	if (params.include?.length && !params.include.some((p) => path.includes(p))) return false;
	if (params.exclude?.length && params.exclude.some((p) => path.includes(p))) return false;
	return true;
}

export function registerTools(pi: ExtensionAPI): void {
	registerSemanticSearchTool(pi);
	registerListCodeTagsTool(pi);
}

function registerListCodeTagsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "list_code_tags",
		label: "List Code Tags",
		description: "List all .index_tag declarations in this project with file counts, descriptions, and declaring directories. Use this before filtering semantic_code_search to understand what tags exist and how many files they cover.",
		promptSnippet: "Discover project tags (name, description, file count) to decide include_tags/exclude_tags for semantic_code_search",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const project = await getProjectInfo(ctx.cwd);
			if (!project.safe) return textResult(`Code index unavailable: ${project.reason}`);
			const { resolved } = await resolveConfig(project);
			const tagMap = await listDeclaredTags(project.root, new Set(resolved.excludeDirs));
			if (tagMap.size === 0) return textResult(EMPTY_TAGS_HELP);
			const manifest = await loadManifest(project);
			const filePaths = manifest ? Object.keys(manifest.files) : [];
			const tagResolver = await buildTagResolver(project.root, new Set(resolved.excludeDirs));
			const stats = computeTagStats(filePaths, (p) => tagResolver.resolveTags(p));
			return textResult(formatDeclaredTags(tagMap, stats));
		},
	});
}

export function registerSemanticSearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "semantic_code_search",
		label: "Semantic Code Search",
		description: "Search the enabled codebase index by meaning/intent when exact keywords or symbol names are unknown.",
		promptSnippet: "Search the codebase semantically by intent when exact keywords are unknown",
		promptGuidelines: [
			"Use semantic_code_search only for intent-based code discovery when you do not know the exact filename, keyword, or symbol name.",
			"Use ffgrep for exact text or identifier search, fffind for file/path discovery, and lsp_navigation for definitions/references instead of semantic_code_search.",
			"The index only covers files that pass all ignore layers: git (root + nested .gitignore, core.excludesFile, .git/info/exclude), then .indexignore, then .contextignore. Add paths to .indexignore to narrow indexing scope without touching git rules.",
			"Tag filtering: this project may declare code tags in .index_tag files (comma/space-separated names, subdirs inherit, no reindex). When tags exist, search results append a tags hint — call list_code_tags for current tags, counts, and untagged share, then pass include_tags/exclude_tags (see their param docs for whitelist-vs-blacklist semantics). You may create or edit .index_tag files to organize areas.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language description of the code you are looking for" }),
			top_k: Type.Optional(Type.Number({ description: "Max results to return (default 8). Raise to scan broadly, lower for precision; clamped to the configured maxTopK." })),
			path: Type.Optional(Type.String({ description: "Optional path prefix to restrict results" })),
			include: Type.Optional(Type.Array(Type.String(), { description: "Optional substring filters that paths must include" })),
			exclude: Type.Optional(Type.Array(Type.String(), { description: "Optional substring filters that paths must not include" })),
			include_tags: Type.Optional(Type.Array(Type.String(), { description: "Strict tag whitelist: only results whose .index_tag-declared tags contain at least one of these pass. Untagged files are excluded when this is set." })),
			exclude_tags: Type.Optional(Type.Array(Type.String(), { description: "Tag exclusion list: results whose .index_tag-declared tags contain any of these are filtered out. Untagged files are not affected." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const project = await getProjectInfo(ctx.cwd);
			const { project: state, resolved } = await resolveConfig(project);
			if (!project.safe) return textResult(`Code index unavailable: ${project.reason}`);
			if (!state.enabled) return textResult("Code index is disabled for this project. Run `/index on` to enable it.");
			const manifest = await loadManifest(project);
			const compatible = manifestCompatible(manifest, resolved);
			if (!manifest) return textResult("Code index is not built yet. Run `/index reindex` to build it.");
			if (!compatible.ok) return textResult(`Code index is stale: ${compatible.reason}. Run /index reindex before searching.`);
			if (!resolved.apiKeyPresent && resolved.provider !== "local") return textResult(`Missing API key env ${resolved.apiKeyEnv}. Configure it or run /index config.`);

			// Normalize tag filter inputs once.
			const includeTags = params.include_tags?.map(normalizeTag).filter((t): t is string => t !== undefined);
			const excludeTags = params.exclude_tags?.map(normalizeTag).filter((t): t is string => t !== undefined);
			const tagFilterActive = (includeTags && includeTags.length > 0) || (excludeTags && excludeTags.length > 0);

			// final-k returned to the agent: the agent chooses freely, clamped only by configured maxTopK.
			const topK = Math.max(1, Math.min(resolved.maxTopK, Math.floor(params.top_k ?? 8)));
			const embedded = await embedTexts(resolved, [params.query], signal, "query");
			if (embedded.dimension !== manifest.embeddingDim) return textResult(`Query embedding dimension ${embedded.dimension} does not match index dimension ${manifest.embeddingDim}. Run /index reindex.`);

			// D4: enlarge candidate pool when include_tags is active (whitelist can be sparse), capped at
			// 1024. The existing pool formula is kept for the exclude-only and no-tag cases.
			const candidateN = includeTags && includeTags.length > 0
				? Math.min(topK * 20, 1024)
				: Math.min(Math.max(topK * 5, topK), 256);
			const raw = await searchIndex(project, embedded.vectors[0], candidateN);

			// Build tag resolver once per query (walks .index_tag files; lightweight, zero reindex).
			// Always construct when !tagFilterActive too, so we can check hasTags for the inline hint.
			const tagResolver = await buildTagResolver(project.root, new Set(resolved.excludeDirs));

			// scoreThreshold (0 = off) trims low-relevance noise before the final-k cut; score is a
			// similarity in (0,1] so higher passes. Lifts precision / agent signal, not recall.
			const results = raw
				.filter((r) => matchesFilters(r.path, params))
				.filter((r) => r.score >= resolved.scoreThreshold)
				.filter((r) => {
					if (!tagFilterActive) return true;
					const fileTags = tagResolver.resolveTags(r.path);
					return matchesTagFilter(fileTags, includeTags, excludeTags);
				})
				.slice(0, topK);

			if (results.length === 0) {
				const hint = tagFilterActive && includeTags && includeTags.length > 0
					? " (include_tags is active — untagged files are excluded; broaden the filter or use exclude_tags instead)"
					: "";
				return textResult(`No semantic code search results found.${hint}`, { results: [] });
			}
			const text = results
				.map((r, i) => `${i + 1}. ${r.path}:${r.startLine}-${r.endLine} score=${r.score.toFixed(3)}${r.symbol ? ` symbol=${r.symbol}` : ""}\n${snippet(r.content)}`)
				.join("\n\n");

			// Inline tag hint: show when tag filter is not active, the project has .index_tag files,
			// and at least one result has tags (so the hint is relevant to this query).
			let inlineHint = "";
			if (!tagFilterActive && tagResolver.hasTags) {
				const anyTagged = results.some((r) => tagResolver.resolveTags(r.path).size > 0);
				if (anyTagged) {
					const filePaths = Object.keys(manifest.files);
					const stats = computeTagStats(filePaths, (p) => tagResolver.resolveTags(p));
					const total = stats.total || 1;
					// Sort by count descending for the inline summary.
					const sorted = [...stats.perTag.entries()].sort(([, a], [, b]) => b - a);
					const tagSummary = sorted.map(([t, n]) => `${t}(${Math.round((n / total) * 100)}%)`).join(" · ");
					inlineHint = `\nℹ tags available: ${tagSummary} — pass include_tags/exclude_tags to filter`;
				}
			}

			return textResult(text + inlineHint, { results });
		},
	});
}
