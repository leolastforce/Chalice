/**
 * Path containment & protected-path predicates.
 */

import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./resolve.ts";
import type { SandboxProfile } from "./schema.ts";

/** Device pseudo-files that are "outside" the project but harmless to allow. */
export const SAFE_OUTSIDE_RE = /^\/dev\/(null|zero|stdin|stdout|stderr|tty|urandom|random)$/;

const PROTECTED_DIRS = [".git", "node_modules", ".vscode", ".idea"];
const PROTECTED_FILES: Record<string, true> = {
  ".gitconfig": true,
  ".gitmodules": true,
  ".npmrc": true,
  ".bashrc": true,
  ".bash_profile": true,
  ".zshrc": true,
  ".zprofile": true,
  ".profile": true,
  ".ripgreprc": true,
  ".envrc": true,
};

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function normalizeToolPath(raw: string): string {
  let p = raw.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) return path.join(os.homedir(), p.slice(2));
  if (/^file:\/\//.test(p)) {
    try {
      return fileURLToPath(p);
    } catch {
      return p;
    }
  }
  return p;
}

function relInside(rel: string): boolean {
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function canonicalize(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (let hops = 0; hops < 40; hops++) {
    try {
      const real = realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      try {
        if (lstatSync(current).isSymbolicLink()) {
          current = path.resolve(path.dirname(current), readlinkSync(current));
          continue;
        }
      } catch {
        // not a symlink
      }
      const parent = path.dirname(current);
      if (parent === current) return tail.length ? path.join(current, ...tail) : current;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  return tail.length ? path.join(current, ...tail) : current;
}

function isWithin(dir: string, target: string): boolean {
  return relInside(path.relative(canonicalize(dir), target));
}

export function isOutside(root: string, p?: string, alsoInside: readonly string[] = []): boolean {
  if (!p) return false;
  const target = canonicalize(path.resolve(root, p));
  if (isWithin(root, target)) return false;
  return !alsoInside.some((dir) => isWithin(dir, target));
}

function isLexicallyInside(root: string, p: string): boolean {
  return relInside(path.relative(path.resolve(root), path.resolve(root, p)));
}

export function bashPathEscapes(root: string, p: string, alsoInside: readonly string[] = []): boolean {
  if (!isOutside(root, p, alsoInside)) return false;
  if (!isLexicallyInside(root, p)) return true;
  try {
    const st = statSync(path.resolve(root, p));
    if (st.isFile() && (st.mode & 0o111) !== 0) return false;
  } catch {
    // dangling link
  }
  return true;
}

export function canonicalPath(root: string, p: string): string {
  return canonicalize(path.resolve(root, p));
}

const UNBLOCKABLE = ["/", "/tmp", "/private", "/private/tmp", "/usr", "/etc", "/var", "/opt", "/home", "/Users", "/bin", "/sbin", "/lib", "/lib64", "/dev", "/proc", "/sys", "/run"];
const SYSTEM_TREES = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

export function blockablePath(
  root: string,
  p: string,
  opts: {
    alsoInside?: readonly string[];
    denyRead?: readonly string[];
    allowRead?: readonly string[];
    protectedDirs?: readonly string[];
  } = {},
): string | undefined {
  const target = canonicalPath(root, p);
  const home = canonicalize(os.homedir());
  if (target === home || UNBLOCKABLE.some((u) => target === u || target === canonicalize(u))) return undefined;
  if (path.dirname(target) === path.parse(target).root) return undefined;
  if (SYSTEM_TREES.some((u) => relInside(path.relative(canonicalize(u), target)))) return undefined;
  for (const d of opts.protectedDirs ?? []) {
    const c = canonicalize(d);
    if (relInside(path.relative(c, target)) || relInside(path.relative(target, c))) return undefined;
  }
  const realRoot = canonicalize(root);
  if (relInside(path.relative(realRoot, target))) return undefined;
  if (relInside(path.relative(target, realRoot))) return undefined;
  for (const r of opts.alsoInside ?? []) {
    if (relInside(path.relative(target, canonicalize(path.resolve(root, expandHome(r)))))) return undefined;
  }
  const allowRead = (opts.allowRead ?? []).map((a) => canonicalize(path.resolve(root, expandHome(a))));
  if (allowRead.some((a) => a !== target && relInside(path.relative(target, a)))) return undefined;
  const reExposed = allowRead.some((a) => a === target || relInside(path.relative(a, target)));
  for (const d of opts.denyRead ?? []) {
    if (!reExposed && relInside(path.relative(canonicalize(expandHome(d)), target))) return undefined;
  }
  return target;
}

export function displayPath(p: string): string {
  const home = os.homedir();
  return p === home ? "~" : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

export const SANDBOX_RUNTIME_TMP_PATHS = ["/tmp/claude", "/private/tmp/claude"];

export function sandboxAllowedRoots(root: string, profile: SandboxProfile): string[] {
  if (!profile.enabled) return [];
  const out: string[] = [];
  for (const raw of [...(profile.allowWrite ?? []), ...SANDBOX_RUNTIME_TMP_PATHS]) {
    if (/[*?[\]{}]/.test(raw)) continue;
    const abs = path.resolve(root, expandHome(raw));
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

export function isMarkdown(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

export function resolvePlanPath(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^@/, "");
}

function looksLikeGitDir(d: string, common: boolean): boolean {
  try {
    if (!statSync(path.join(d, "HEAD")).isFile()) return false;
    if (!common) return true;
    return statSync(path.join(d, "objects")).isDirectory() && statSync(path.join(d, "refs")).isDirectory();
  } catch {
    return false;
  }
}

function unsafeGitDir(d: string, realRoot: string): boolean {
  const home = canonicalize(os.homedir());
  if (d === path.parse(d).root || path.dirname(d) === path.parse(d).root) return true;
  if (relInside(path.relative(d, home)) || relInside(path.relative(d, realRoot))) return true;
  return relInside(path.relative(realRoot, d));
}

export function gitDirsOf(root: string): { gitdir: string; commondir: string } | undefined {
  const gitfile = path.join(root, ".git");
  try {
    if (!lstatSync(gitfile).isFile()) return undefined;
    const first = readFileSync(gitfile, "utf8").split(/\r?\n/, 1)[0];
    const m = /^gitdir: (.+)$/.exec(first);
    if (!m) return undefined;
    const realRoot = canonicalize(root);
    const realGitfile = realpathSync(gitfile);
    const gitdir = realpathSync(path.resolve(root, m[1].trim()));
    let commondir: string;
    if (path.basename(path.dirname(gitdir)) === "worktrees") {
      commondir = path.dirname(path.dirname(gitdir));
      if (!looksLikeGitDir(gitdir, false) || !looksLikeGitDir(commondir, true)) return undefined;
      const back = readFileSync(path.join(gitdir, "gitdir"), "utf8").trim();
      if (realpathSync(path.resolve(gitdir, back)) !== realGitfile) return undefined;
    } else {
      commondir = gitdir;
      if (!gitdir.split(path.sep).includes("modules") || !looksLikeGitDir(gitdir, true)) return undefined;
      const cfg = readFileSync(path.join(gitdir, "config"), "utf8");
      const wt = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(cfg.slice(Math.max(0, cfg.search(/^\s*\[core\]/m))));
      if (!wt || realpathSync(path.resolve(gitdir, wt[1])) !== realRoot) return undefined;
    }
    if (unsafeGitDir(gitdir, realRoot) || unsafeGitDir(commondir, realRoot)) return undefined;
    return { gitdir, commondir };
  } catch {
    return undefined;
  }
}

export function isPlanFile(root: string, p?: string): boolean {
  if (!p || !isMarkdown(p)) return false;
  const rel = path.relative(path.resolve(root, "plan"), path.resolve(root, p));
  return rel !== "" && relInside(rel);
}

export function isProtectedPath(p: string): boolean {
  const segments = p
    .split(/[/\\]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (segments.length === 0) return false;
  const base = segments[segments.length - 1];

  if (segments.some((s) => PROTECTED_DIRS.includes(s))) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (PROTECTED_FILES[base]) return true;
  for (let i = 0; i + 1 < segments.length; i++) {
    if (segments[i] === ".claude" && (segments[i + 1] === "commands" || segments[i + 1] === "agents")) return true;
  }
  return false;
}

export function isProtectedWrite(root: string, p: string): boolean {
  if (isProtectedPath(p)) return true;
  const target = canonicalize(path.resolve(root, p));
  const realRoot = canonicalize(root);
  const rel = path.relative(realRoot, target);
  return isProtectedPath(relInside(rel) ? rel : target);
}
