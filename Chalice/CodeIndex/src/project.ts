import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, parse, resolve } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { ProjectInfo } from "./types.ts";

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "deno.json", "bun.lock", "pnpm-lock.yaml", "yarn.lock"];
const DENY_BASENAMES = new Set(["Desktop", "Documents", "Downloads", "Pictures", "Music", "Movies", "Videos", "Public", "Templates", "Applications", "Library", "System", "Volumes", "Users", "Program Files", "Program Files (x86)", "ProgramData", "Windows", "PerfLogs", "AppData", "OneDrive", "Dropbox", "Google Drive", "iCloud Drive"]);

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function hasMarker(dir: string): Promise<boolean> {
	for (const marker of PROJECT_MARKERS) {
		if (await exists(join(dir, marker))) return true;
	}
	return false;
}

export async function findProjectRoot(cwd: string): Promise<string> {
	const start = resolve(cwd);
	const home = process.env.HOME ? resolve(process.env.HOME) : undefined;
	let cur = start;
	while (true) {
		// Never auto-select $HOME (or above) as the root unless pi was literally started there.
		// Otherwise a stray package.json in $HOME hijacks a cwd like ~/Workspace and the safe-root
		// check then refuses the whole thing.
		if (home && cur === home && start !== home) return start;
		if (await hasMarker(cur)) return cur;
		const parent = dirname(cur);
		if (parent === cur) return start;
		cur = parent;
	}
}

export function projectHash(root: string): string {
	return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function isSafeProjectRoot(root: string): { safe: boolean; reason?: string } {
	const resolved = resolve(root);
	const parsed = parse(resolved);
	if (resolved === parsed.root) return { safe: false, reason: "refusing to index filesystem root" };
	if (resolved === process.env.HOME) return { safe: false, reason: "refusing to index home directory" };
	if (DENY_BASENAMES.has(basename(resolved))) return { safe: false, reason: `refusing protected directory ${basename(resolved)}` };
	return { safe: true };
}

export async function getProjectInfo(cwd: string): Promise<ProjectInfo> {
	const root = await findProjectRoot(cwd);
	const hash = projectHash(root);
	const projectPi = join(root, CONFIG_DIR_NAME);
	const indexDir = join(DATA_DIR, "indexes", hash);
	const safety = isSafeProjectRoot(root);
	return {
		cwd,
		root,
		hash,
		statePath: join(projectPi, "code-index.json"),
		indexDir,
		manifestPath: join(indexDir, "manifest.json"),
		safe: safety.safe,
		reason: safety.reason,
	};
}

export function relPath(root: string, absPath: string): string {
	return resolve(absPath).slice(resolve(root).length + 1).replaceAll("\\", "/");
}
