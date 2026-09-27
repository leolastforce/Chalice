import fg from "fast-glob";
import ignore from "ignore";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectInfo, ResolvedConfig, SourceFile } from "./types.ts";

const execFileAsync = promisify(execFile);

const SPECIAL_FILENAMES = new Map([
	["Dockerfile", "dockerfile"],
	["Containerfile", "dockerfile"],
	["Makefile", "makefile"],
	["CMakeLists.txt", "cmake"],
	["BUILD", "bazel"],
	["BUILD.bazel", "bazel"],
	["MODULE.bazel", "bazel"],
	["WORKSPACE", "bazel"],
	["WORKSPACE.bazel", "bazel"],
]);

const SECRET_BASENAME_PATTERNS = [/^\.env(?:\..*)?$/i, /^id_rsa$/i, /^id_dsa$/i, /^id_ecdsa$/i, /^id_ed25519$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i];
const SECRET_CONTENT_PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /AWS_SECRET_ACCESS_KEY\s*=/, /OPENAI_API_KEY\s*=/, /ANTHROPIC_API_KEY\s*=/, /VOYAGE_API_KEY\s*=/, /OPENROUTER_API_KEY\s*=/];

function normalizePattern(pattern: string): string {
	return pattern.replaceAll("\\", "/");
}

async function loadIgnoreFile(path: string): Promise<string[]> {
	try {
		const text = await readFile(path, "utf8");
		return text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
	} catch {
		return [];
	}
}

// Call git to list all tracked + untracked-but-not-ignored files in the repo.
// Returns relative posix paths, or undefined if root is not a git repo or git fails/times out.
async function gitListFiles(root: string): Promise<string[] | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{ timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
		);
		return stdout.split("\0").filter((p) => p.length > 0).map((p) => p.replaceAll("\\", "/"));
	} catch {
		return undefined;
	}
}

export async function buildIgnoreMatcher(project: ProjectInfo, config: ResolvedConfig, isGitRepo: boolean) {
	const ig = ignore();
	ig.add(config.excludeDirs.flatMap((dir) => [`${dir}/`, `**/${dir}/`]));
	// When git is acting as the file-list oracle it already handles all four ignore layers
	// (.gitignore, nested .gitignore, core.excludesFile, .git/info/exclude). Reading .gitignore
	// again here would cause double-application and could trip up the `ignore` library.
	if (!isGitRepo) ig.add(await loadIgnoreFile(join(project.root, ".gitignore")));
	ig.add(await loadIgnoreFile(join(project.root, ".indexignore")));
	ig.add(await loadIgnoreFile(join(project.root, ".contextignore")));
	return ig;
}

export function languageForPath(path: string): string | undefined {
	const base = basename(path);
	if (SPECIAL_FILENAMES.has(base)) return SPECIAL_FILENAMES.get(base);
	const ext = extname(path).toLowerCase();
	const map: Record<string, string> = {
		".ts": "typescript",
		".tsx": "tsx",
		".js": "javascript",
		".jsx": "jsx",
		".mjs": "javascript",
		".cjs": "javascript",
		".py": "python",
		".rs": "rust",
		".go": "go",
		".java": "java",
		".kt": "kotlin",
		".kts": "kotlin",
		".scala": "scala",
		".sc": "scala",
		".swift": "swift",
		".c": "c",
		".cpp": "cpp",
		".cc": "cpp",
		".cxx": "cpp",
		".h": "c",
		".hpp": "cpp",
		".m": "objective-c",
		".mm": "objective-cpp",
		".cu": "cuda",
		".cuh": "cuda",
		".cs": "csharp",
		".fs": "fsharp",
		".fsx": "fsharp",
		".rb": "ruby",
		".php": "php",
		".lua": "lua",
		".r": "r",
		".jl": "julia",
		".dart": "dart",
		".ex": "elixir",
		".exs": "elixir",
		".erl": "erlang",
		".hrl": "erlang",
		".hs": "haskell",
		".lhs": "haskell",
		".clj": "clojure",
		".cljs": "clojure",
		".edn": "edn",
		".nim": "nim",
		".zig": "zig",
		".v": "verilog",
		".sv": "systemverilog",
		".svh": "systemverilog",
		".sol": "solidity",
		".sql": "sql",
		".proto": "protobuf",
		".graphql": "graphql",
		".gql": "graphql",
		".prisma": "prisma",
		".tf": "terraform",
		".tfvars": "terraform",
		".hcl": "hcl",
		".nix": "nix",
		".vue": "vue",
		".svelte": "svelte",
		".html": "html",
		".css": "css",
		".scss": "scss",
		".xml": "xml",
		".md": "markdown",
		".mdx": "markdown",
		".adoc": "asciidoc",
		".txt": "text",
		".rst": "rst",
		".tex": "latex",
		".bib": "bibtex",
		".yaml": "yaml",
		".yml": "yaml",
		".toml": "toml",
		".json": "json",
		".ini": "ini",
		".cfg": "config",
		".conf": "config",
		".properties": "properties",
		".sh": "shell",
		".bash": "shell",
		".zsh": "shell",
		".ps1": "powershell",
		".cmake": "cmake",
		".gradle": "gradle",
		".bazel": "bazel",
		".bzl": "bazel",
		".dockerfile": "dockerfile",
		".containerfile": "dockerfile",
	};
	return map[ext];
}

export function isSecretPath(path: string): boolean {
	const base = basename(path);
	return SECRET_BASENAME_PATTERNS.some((r) => r.test(base));
}

function looksBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 4096);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

function hasSecretContent(text: string): boolean {
	return SECRET_CONTENT_PATTERNS.some((r) => r.test(text));
}

export async function listIndexableFiles(project: ProjectInfo, config: ResolvedConfig): Promise<string[]> {
	const gitFiles = await gitListFiles(project.root);
	const isGitRepo = gitFiles !== undefined;
	const ig = await buildIgnoreMatcher(project, config, isGitRepo);
	let entries: string[];
	if (isGitRepo) {
		entries = gitFiles;
	} else {
		const raw = await fg("**/*", {
			cwd: project.root,
			dot: true,
			onlyFiles: true,
			followSymbolicLinks: false,
			ignore: config.excludeDirs.flatMap((dir) => [`**/${dir}/**`, `${dir}/**`]),
		});
		entries = raw.map(normalizePattern);
	}
	// Git visibility and content checks determine eligibility. Extension mappings are used only for
	// syntax-aware chunking; unknown readable files are indexed as plain text.
	return entries.filter((p) => !ig.ignores(p)).filter((p) => !isSecretPath(p));
}

export async function readSourceFile(project: ProjectInfo, relPath: string, config: ResolvedConfig): Promise<SourceFile | undefined> {
	const absPath = join(project.root, relPath);
	const st = await stat(absPath).catch(() => undefined);
	if (!st || !st.isFile()) return undefined;
	if (st.size > config.maxFileBytes) return undefined;
	if (isSecretPath(relPath)) return undefined;
	const buf = await readFile(absPath);
	if (looksBinary(buf)) return undefined;
	const content = buf.toString("utf8");
	if (content.includes("�")) return undefined;
	if (hasSecretContent(content)) return undefined;
	const language = languageForPath(relPath) ?? "text";
	const fileHash = createHash("sha256").update(buf).digest("hex");
	return { path: relPath, absPath, language, content, size: st.size, mtimeMs: st.mtimeMs, fileHash };
}

export async function isPathIndexable(project: ProjectInfo, config: ResolvedConfig, relPath: string): Promise<boolean> {
	const files = await listIndexableFiles(project, config);
	return files.includes(normalizePattern(relPath));
}
