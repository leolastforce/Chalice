import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Normalize a raw tag token: lowercase, trim, keep only [a-z0-9_-]. Returns undefined if nothing valid remains. */
export function normalizeTag(raw: string): string | undefined {
	const s = raw.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
	return s.length > 0 ? s : undefined;
}

interface TagFileResult {
	tags: Set<string>;
	description?: string;
}

/** Parse a single `.index_tag` file. `#` comment lines are skipped for tags; the first `#` comment
 *  line (stripped of the leading `#` and trimmed) is used as a human-readable description (truncated
 *  to ~120 characters to avoid layout issues). */
async function parseTagFile(absPath: string): Promise<TagFileResult> {
	let text: string;
	try {
		text = await readFile(absPath, "utf8");
	} catch {
		return { tags: new Set() };
	}
	const tags = new Set<string>();
	let description: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("#")) {
			if (description === undefined) {
				const raw = trimmed.slice(1).trim();
				if (raw) description = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
			}
			continue;
		}
		for (const token of trimmed.split(/[\s,]+/)) {
			const tag = normalizeTag(token);
			if (tag) tags.add(tag);
		}
	}
	return { tags, description };
}

async function isDirectory(absPath: string): Promise<boolean> {
	try {
		return (await stat(absPath)).isDirectory();
	} catch {
		return false;
	}
}

interface TagFileEntry {
	tags: Set<string>;
	description?: string;
}

/** Walk directory tree rooted at `root`, collect all `.index_tag` files, return a map of dir→{tags,description}.
 *  Directory basenames in `excludeDirs` (e.g. node_modules, .git) are skipped entirely. */
async function collectTagFiles(root: string, excludeDirs: Set<string>): Promise<Map<string, TagFileEntry>> {
	const result = new Map<string, TagFileEntry>();

	async function walk(dir: string): Promise<void> {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		if (names.includes(".index_tag")) {
			const { tags, description } = await parseTagFile(join(dir, ".index_tag"));
			result.set(dir, { tags, description });
		}
		await Promise.all(
			names.map(async (name) => {
				if (excludeDirs.has(name)) return;
				const child = join(dir, name);
				if (await isDirectory(child)) await walk(child);
			}),
		);
	}

	await walk(root);
	return result;
}

export interface TagResolver {
	/** Return the union of all tags declared in ancestor `.index_tag` files for the given project-relative path. */
	resolveTags(relPath: string): Set<string>;
	/** Whether any `.index_tag` files were found (i.e. the project uses tag declarations). */
	hasTags: boolean;
}

/**
 * Build a TagResolver for the given project root. Walks the directory tree once to read all `.index_tag`
 * files, then resolves per-file tags by walking the ancestor chain and taking the union.
 *
 * Designed to be constructed once per query — `.index_tag` files are few and the walk is lightweight.
 */
// Cache the walked .index_tag map briefly: the inline tag hint builds a resolver on EVERY search
// (even tag-free ones), so back-to-back searches would otherwise re-walk the source tree each time.
// Short TTL keeps .index_tag edits effectively immediate (visible within a few seconds).
const RESOLVER_TTL_MS = 3000;
const resolverCache = new Map<string, { resolver: TagResolver; builtAt: number }>();

export async function buildTagResolver(projectRoot: string, excludeDirs: Set<string>): Promise<TagResolver> {
	const cached = resolverCache.get(projectRoot);
	if (cached && Date.now() - cached.builtAt < RESOLVER_TTL_MS) return cached.resolver;
	const dirTagMap = await collectTagFiles(projectRoot, excludeDirs);

	function resolveTags(relPath: string): Set<string> {
		const absPath = join(projectRoot, relPath);
		const fileDir = dirname(absPath);
		const union = new Set<string>();
		let cur = fileDir;
		while (true) {
			const entry = dirTagMap.get(cur);
			if (entry) {
				for (const t of entry.tags) union.add(t);
			}
			if (cur === projectRoot) break;
			const parent = dirname(cur);
			if (parent === cur) break; // filesystem root guard
			cur = parent;
		}
		return union;
	}

	const resolver: TagResolver = { resolveTags, hasTags: dirTagMap.size > 0 };
	resolverCache.set(projectRoot, { resolver, builtAt: Date.now() });
	return resolver;
}

export interface TagStats {
	/** Per-tag hit count across the given file paths. */
	perTag: Map<string, number>;
	/** Number of files with no tags at all. */
	untagged: number;
	/** Total file count. */
	total: number;
}

/**
 * Compute per-tag file counts and the untagged count by walking `filePaths` through `resolve`.
 * Purely path-based — never reads file contents.
 */
export function computeTagStats(filePaths: string[], resolve: (p: string) => Set<string>): TagStats {
	const perTag = new Map<string, number>();
	let untagged = 0;
	for (const p of filePaths) {
		const tags = resolve(p);
		if (tags.size === 0) {
			untagged++;
		} else {
			for (const t of tags) {
				perTag.set(t, (perTag.get(t) ?? 0) + 1);
			}
		}
	}
	return { perTag, untagged, total: filePaths.length };
}

export interface DeclaredTagInfo {
	/** Sorted project-relative directories that declare this tag. */
	dirs: string[];
	/** First `#` comment line from the .index_tag file(s) declaring this tag, if any. */
	description?: string;
}

/**
 * Walk the project tree, collect all `.index_tag` declarations, and return a sorted map of
 * tag → { dirs, description }. Used by `/index tags` and `list_code_tags`.
 */
export async function listDeclaredTags(projectRoot: string, excludeDirs: Set<string>): Promise<Map<string, DeclaredTagInfo>> {
	const dirTagMap = await collectTagFiles(projectRoot, excludeDirs);
	const tagToDirs = new Map<string, Set<string>>();
	const tagToDesc = new Map<string, string>();
	for (const [absDir, { tags, description }] of dirTagMap) {
		const relDir = absDir === projectRoot ? "." : absDir.slice(projectRoot.length + 1);
		for (const tag of tags) {
			if (!tagToDirs.has(tag)) tagToDirs.set(tag, new Set());
			tagToDirs.get(tag)!.add(relDir);
			// First description seen for this tag wins.
			if (description && !tagToDesc.has(tag)) tagToDesc.set(tag, description);
		}
	}
	const result = new Map<string, DeclaredTagInfo>();
	for (const [tag, dirs] of [...tagToDirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		result.set(tag, { dirs: [...dirs].sort(), description: tagToDesc.get(tag) });
	}
	return result;
}

/** Agent-facing help shown when no .index_tag files exist. */
export const EMPTY_TAGS_HELP = [
	"No .index_tag files in this project yet.",
	"To organize areas for filtered search, create a .index_tag in any directory:",
	"  # one-line description of what these tags mean",
	"  test, e2e",
	"Subdirectories inherit. Filter with include_tags / exclude_tags. No reindex needed.",
].join("\n");

/**
 * Format declared tags + stats into the agent-facing list (shared by `list_code_tags` and `/index tags`).
 * Alignment uses only the ASCII tag and count columns; the (possibly CJK) description is placed last so
 * its display width can't break the layout.
 */
export function formatDeclaredTags(tagMap: Map<string, DeclaredTagInfo>, stats: TagStats): string {
	const total = stats.total || 1;
	const maxTagLen = [...tagMap.keys()].reduce((m, t) => Math.max(m, t.length), 0);
	const lines = ["Tags declared in this project (.index_tag files):", ""];
	for (const [tag, { dirs, description }] of tagMap) {
		const count = stats.perTag.get(tag) ?? 0;
		const pct = Math.round((count / total) * 100);
		const head = `  ${tag.padEnd(maxTagLen)}  ${`${count} files · ${pct}%`.padEnd(16)}`;
		lines.push(description ? `${head}  ${description}` : head.trimEnd());
		lines.push(`  ${" ".repeat(maxTagLen)}  declared in: ${dirs.join(", ")}`);
	}
	if (stats.untagged > 0) {
		const pct = Math.round((stats.untagged / total) * 100);
		lines.push(`  (untagged: ${stats.untagged} files · ${pct}% — excluded by include_tags)`);
	}
	lines.push("", "Filter semantic_code_search:");
	lines.push(`  exclude_tags: ["test"]            skip tagged areas (untagged unaffected)`);
	lines.push(`  include_tags: ["core","harness"]  whitelist: keep files matching ANY (untagged excluded)`);
	return lines.join("\n");
}

/**
 * D3 filter semantics:
 * - `exclude_tags`: if the file's tags contain ANY exclude tag → filtered out. Untagged files are unaffected.
 * - `include_tags`: strict whitelist — only files with ANY include tag pass. Untagged files are excluded.
 * - Both empty → no filtering (pass-through).
 */
export function matchesTagFilter(
	fileTags: Set<string>,
	includeTags?: string[],
	excludeTags?: string[],
): boolean {
	if (excludeTags && excludeTags.length > 0) {
		if (excludeTags.some((t) => fileTags.has(t))) return false;
	}
	if (includeTags && includeTags.length > 0) {
		if (!includeTags.some((t) => fileTags.has(t))) return false;
	}
	return true;
}
