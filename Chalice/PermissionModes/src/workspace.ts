import { constants, lstatSync, type BigIntStats, type Stats } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  unlink,
  symlink,
  realpath,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorkspaceChange {
  path: string;
  change: "added" | "deleted" | "modified";
  kind: "file" | "directory" | "symlink";
}

export interface WorkspaceReview {
  changes: WorkspaceChange[];
  conflicts: string[];
  diff: string;
  diffTruncated: boolean;
}

interface FileState {
  kind: "file" | "directory" | "symlink";
  mode: number;
  size: string;
  device: string;
  inode: string;
  modified: string;
  changed: string;
  target?: string;
  normalizedTarget?: string;
}

interface TreeChange {
  path: string;
  before?: FileState;
  after?: FileState;
}

const MAX_DIFF_CHARS = 20_000_000;
const COPY_MODE = constants.COPYFILE_FICLONE;

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function relativeInside(root: string, target: string): string | undefined {
  const path = relative(root, target);
  if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) return path;
  return undefined;
}

function normalizeLinkTarget(root: string, target: string): string {
  if (!isAbsolute(target)) return target;
  const internalPath = relativeInside(root, resolve(target));
  return internalPath === undefined ? target : `internal:${portablePath(internalPath)}`;
}

function mapWorkspaceLinkTarget(target: string, workspaceRoot: string, sourceRoot: string): string {
  if (!isAbsolute(target)) return target;
  const internalPath = relativeInside(workspaceRoot, resolve(target));
  return internalPath === undefined ? target : join(sourceRoot, internalPath);
}

function shouldCopyWorkspaceEntry(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  if (pathFromRoot.split(sep).includes(".git")) return false;
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() || stats.isFile() || stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function shouldCopyGitEntry(path: string): boolean {
  if (basename(path).endsWith(".lock")) return false;
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() || stats.isFile() || stats.isSymbolicLink();
  } catch {
    return false;
  }
}

async function copyTree(source: string, destination: string, filter: (path: string) => boolean): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    mode: COPY_MODE,
    filter,
  });
}

async function rewriteInternalAbsoluteSymlinks(sourceRoot: string, destinationRoot: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        const target = await readlink(path);
        if (!isAbsolute(target)) continue;
        const relativeTarget = relativeInside(sourceRoot, resolve(target));
        if (relativeTarget === undefined) continue;
        const mappedTarget = join(destinationRoot, relativeTarget);
        const mappedLinkTarget = relative(dirname(path), mappedTarget) || ".";
        await unlink(path);
        let type: "file" | "junction" | undefined;
        if (process.platform === "win32") {
          type = "file";
          try {
            if ((await lstat(mappedTarget)).isDirectory()) type = "junction";
          } catch {
            // A broken target can only be recreated as a file link on Windows.
          }
        }
        await symlink(mappedLinkTarget, path, type);
      } else if (stats.isDirectory()) {
        await visit(path);
      }
    }
  }

  await visit(destinationRoot);
}

function runGit(args: string[], cwd: string, maxBuffer = 128 * 1024 * 1024): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer }, (error, stdout, stderr) => {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (error && code !== 1) {
        reject(new Error(typeof stderr === "string" && stderr.trim() ? stderr.trim() : error.message));
        return;
      }
      resolveOutput(stdout);
    });
  });
}

async function copyGitMetadata(sourceRoot: string, workspaceRoot: string): Promise<void> {
  const sourceGit = join(sourceRoot, ".git");
  const targetGit = join(workspaceRoot, ".git");
  let sourceStats: Stats;
  try {
    sourceStats = await lstat(sourceGit);
  } catch {
    return;
  }

  if (sourceStats.isDirectory()) {
    await copyTree(sourceGit, targetGit, shouldCopyGitEntry);
  } else if (sourceStats.isFile()) {
    const marker = await readFile(sourceGit, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/m.exec(marker);
    if (!match?.[1]) return;

    const worktreeGit = resolve(sourceRoot, match[1]);
    let commonGit = worktreeGit;
    try {
      const commonRelative = (await readFile(join(worktreeGit, "commondir"), "utf8")).trim();
      if (commonRelative) commonGit = resolve(worktreeGit, commonRelative);
    } catch {
      // A regular gitdir has no commondir file.
    }

    await copyTree(commonGit, targetGit, shouldCopyGitEntry);
    if (commonGit !== worktreeGit) {
      for (const name of await readdir(worktreeGit)) {
        if (name === "commondir" || name === "gitdir" || name.endsWith(".lock")) continue;
        const sourcePath = join(worktreeGit, name);
        if (!shouldCopyGitEntry(sourcePath)) continue;
        await cp(sourcePath, join(targetGit, name), {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
          mode: COPY_MODE,
          filter: shouldCopyGitEntry,
        });
      }
    }
  } else if (sourceStats.isSymbolicLink()) {
    const target = await readlink(sourceGit);
    const resolvedTarget = resolve(dirname(sourceGit), target);
    await copyTree(resolvedTarget, targetGit, shouldCopyGitEntry);
  }

  try {
    await runGit([`--git-dir=${targetGit}`, "config", "core.worktree", workspaceRoot], workspaceRoot);
    await runGit([`--git-dir=${targetGit}`, "config", "core.bare", "false"], workspaceRoot);
  } catch {
    // File changes remain isolated even when Git metadata cannot be initialized.
  }
}

async function captureTree(root: string): Promise<Map<string, FileState>> {
  const result = new Map<string, FileState>();

  async function visit(directory: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    names.sort();

    for (const name of names) {
      if (name === ".git") continue;
      const absolutePath = join(directory, name);
      const path = portablePath(relative(root, absolutePath));
      let stats: BigIntStats;
      try {
        stats = await lstat(absolutePath, { bigint: true });
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }

      let kind: FileState["kind"] | undefined;
      if (stats.isDirectory()) kind = "directory";
      else if (stats.isFile()) kind = "file";
      else if (stats.isSymbolicLink()) kind = "symlink";
      if (!kind) continue;

      const entry: FileState = {
        kind,
        mode: Number(stats.mode & 0o7777n),
        size: stats.size.toString(),
        device: stats.dev.toString(),
        inode: stats.ino.toString(),
        modified: stats.mtimeNs.toString(),
        changed: stats.ctimeNs.toString(),
      };
      if (kind === "symlink") {
        entry.target = await readlink(absolutePath);
        entry.normalizedTarget = normalizeLinkTarget(root, entry.target);
      }
      result.set(path, entry);
      if (kind === "directory") await visit(absolutePath);
    }
  }

  await visit(root);
  return result;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sameState(a: FileState | undefined, b: FileState | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.kind === b.kind &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.device === b.device &&
    a.inode === b.inode &&
    a.modified === b.modified &&
    a.changed === b.changed &&
    a.target === b.target
  );
}


async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function treeChanges(before: Map<string, FileState>, after: Map<string, FileState>): TreeChange[] {
  const changes: TreeChange[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const oldState = before.get(path);
    const newState = after.get(path);
    if (!oldState || !newState || oldState.kind !== newState.kind) {
      changes.push({ path, before: oldState, after: newState });
    } else if (oldState.kind === "directory") {
      if (oldState.mode !== newState.mode) changes.push({ path, before: oldState, after: newState });
    } else if (oldState.kind === "symlink") {
      if ((oldState.normalizedTarget ?? oldState.target) !== (newState.normalizedTarget ?? newState.target) || oldState.mode !== newState.mode) {
        changes.push({ path, before: oldState, after: newState });
      }
    } else if (
      oldState.mode !== newState.mode ||
      oldState.size !== newState.size ||
      oldState.modified !== newState.modified ||
      oldState.changed !== newState.changed ||
      oldState.inode !== newState.inode
    ) {
      changes.push({ path, before: oldState, after: newState });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}


function treeConflicts(before: Map<string, FileState>, after: Map<string, FileState>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => !sameState(before.get(path), after.get(path)))
    .sort((a, b) => a.localeCompare(b));
}


function publicChanges(changes: TreeChange[]): WorkspaceChange[] {
  return changes.map(({ path, before, after }) => ({
    path,
    change: !before ? "added" : !after ? "deleted" : "modified",
    kind: (after ?? before)!.kind,
  }));
}

function changeSummary(changes: WorkspaceChange[]): string {
  return changes.map((change) => `${change.change} ${change.kind}: ${change.path}`).join("\n");
}

async function simpleDiff(root: string, changes: WorkspaceChange[]): Promise<string> {
  const sections: string[] = [];
  for (const change of changes) {
    const before = change.change === "added" ? undefined : join(root, "snapshot", ...change.path.split("/"));
    const after = change.change === "deleted" ? undefined : join(root, "workspace", ...change.path.split("/"));
    let section = `--- ${before ? `a/${change.path}` : "/dev/null"}\n+++ ${after ? `b/${change.path}` : "/dev/null"}\n`;
    if (change.kind !== "file") {
      section += `[${change.kind} ${change.change}]\n`;
    } else {
      const oldBytes = before ? await readFile(before) : Buffer.alloc(0);
      const newBytes = after ? await readFile(after) : Buffer.alloc(0);
      if (oldBytes.includes(0) || newBytes.includes(0)) {
        section += "[binary content changed]\n";
      } else {
        if (before) section += oldBytes.toString("utf8").split(/(?<=\n)/).map((line) => `-${line}`).join("");
        if (after) section += newBytes.toString("utf8").split(/(?<=\n)/).map((line) => `+${line}`).join("");
      }
    }
    sections.push(section);
  }
  return sections.join("\n");
}

function assertSafeRelativePath(path: string): void {
  if (path.startsWith("/") || path.split("/").includes("..") || path.split("/").includes(".git")) {
    throw new Error(`Refusing to apply unsafe workspace path: ${path}`);
  }
}

async function readFileState(path: string): Promise<FileState | undefined> {
  try {
    const stats = await lstat(path, { bigint: true });
    const kind: FileState["kind"] | undefined = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : stats.isSymbolicLink()
          ? "symlink"
          : undefined;
    if (!kind) return undefined;
    const state: FileState = {
      kind,
      mode: Number(stats.mode & 0o7777n),
      size: stats.size.toString(),
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      modified: stats.mtimeNs.toString(),
      changed: stats.ctimeNs.toString(),
    };
    if (kind === "symlink") state.target = await readlink(path);
    return state;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function sameForConflict(expected: FileState | undefined, actual: FileState | undefined): boolean {
  if (!expected || !actual) return expected === actual;
  if (expected.kind === "directory" && actual.kind === "directory") {
    return expected.mode === actual.mode && expected.device === actual.device && expected.inode === actual.inode;
  }
  return sameState(expected, actual);
}

async function replaceWithFile(source: string, destination: string, mode: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.chalice-${randomUUID()}.tmp`;
  try {
    await cp(source, temporaryPath, { mode: COPY_MODE, preserveTimestamps: true });
    await chmod(temporaryPath, mode);
    try {
      await rename(temporaryPath, destination);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await rm(destination, { force: true, recursive: true });
      await rename(temporaryPath, destination);
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function replaceWithSymlink(source: string, destination: string, target: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.chalice-${randomUUID()}.tmp`;
  try {
    let type: "file" | "junction" | undefined;
    if (process.platform === "win32") {
      type = "file";
      try {
        const targetPath = resolve(dirname(source), target);
        if ((await lstat(targetPath)).isDirectory()) type = "junction";
      } catch {
        // A broken link can only be recreated as a file link on Windows.
      }
    }
    await symlink(target, temporaryPath, type);
    try {
      await rename(temporaryPath, destination);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await rm(destination, { force: true, recursive: true });
      await rename(temporaryPath, destination);
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export class WorkspaceConflictError extends Error {
  readonly paths: string[];

  constructor(paths: string[]) {
    super(`Workspace changed outside the staged result: ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ` and ${paths.length - 10} more` : ""}`);
    this.name = "WorkspaceConflictError";
    this.paths = paths;
  }
}

export class ConfirmWorkspace {
  readonly sourceRoot: string;
  readonly directory: string;
  readonly workingDirectory: string;
  private readonly snapshotDirectory: string;
  private readonly sourceState: Map<string, FileState>;
  private readonly initialWorkspaceState: Map<string, FileState>;
  private disposed = false;

  private constructor(options: {
    sourceRoot: string;
    directory: string;
    snapshotDirectory: string;
    workingDirectory: string;
    sourceState: Map<string, FileState>;
    initialWorkspaceState: Map<string, FileState>;
  }) {
    this.sourceRoot = options.sourceRoot;
    this.directory = options.directory;
    this.snapshotDirectory = options.snapshotDirectory;
    this.workingDirectory = options.workingDirectory;
    this.sourceState = options.sourceState;
    this.initialWorkspaceState = options.initialWorkspaceState;
  }

  static async create(cwd: string): Promise<ConfirmWorkspace> {
    const sourceRoot = await realpath(cwd);
    const sourceState = await captureTree(sourceRoot);
    const directory = await mkdtemp(join(tmpdir(), "chalice-confirm-"));
    const snapshotDirectory = join(directory, "snapshot");
    const workingDirectory = join(directory, "workspace");

    try {
      await copyTree(sourceRoot, snapshotDirectory, (path) => shouldCopyWorkspaceEntry(sourceRoot, path));
      await rewriteInternalAbsoluteSymlinks(sourceRoot, snapshotDirectory);
      await copyTree(snapshotDirectory, workingDirectory, (path) => shouldCopyWorkspaceEntry(snapshotDirectory, path));
      await rewriteInternalAbsoluteSymlinks(snapshotDirectory, workingDirectory);
      await copyGitMetadata(sourceRoot, workingDirectory);

      const sourceAfterCopy = await captureTree(sourceRoot);
      const copyConflicts = treeConflicts(sourceState, sourceAfterCopy);
      if (copyConflicts.length > 0) throw new WorkspaceConflictError(copyConflicts);

      const initialWorkspaceState = await captureTree(workingDirectory);
      return new ConfirmWorkspace({
        sourceRoot,
        directory,
        snapshotDirectory,
        workingDirectory,
        sourceState,
        initialWorkspaceState,
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async review(): Promise<WorkspaceReview> {
    this.assertActive();
    const [currentSource, currentWorkspace] = await Promise.all([
      captureTree(this.sourceRoot),
      captureTree(this.workingDirectory),
    ]);
    const conflicts = treeConflicts(this.sourceState, currentSource);
    const candidates = treeChanges(this.initialWorkspaceState, currentWorkspace);
    const changes: TreeChange[] = [];

    for (const candidate of candidates) {
      if (candidate.before?.kind === "file" && candidate.after?.kind === "file" && candidate.before.mode === candidate.after.mode) {
        const oldPath = join(this.snapshotDirectory, ...candidate.path.split("/"));
        const newPath = join(this.workingDirectory, ...candidate.path.split("/"));
        if (await hashFile(oldPath) === await hashFile(newPath)) continue;
      }
      changes.push(candidate);
    }

    const publicChangeList = publicChanges(changes);
    let diff = "";
    if (publicChangeList.length > 0) {
      const result = await this.renderDiff();
      diff = result.diff;
      if (diff.length === 0) diff = changeSummary(publicChangeList);
      if (diff.length > MAX_DIFF_CHARS) {
        diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[Diff truncated; ${diff.length - MAX_DIFF_CHARS} characters omitted.]`;
      }
      if (changes.some((change) => change.before?.kind === "directory" || change.after?.kind === "directory")) {
        diff = `${changeSummary(publicChangeList)}\n\n${diff}`;
      }
    }

    return {
      changes: publicChangeList,
      conflicts,
      diff,
      diffTruncated: diff.includes("[Diff truncated;"),
    };
  }

  async apply(): Promise<{ applied: string[]; conflicts: string[] }> {
    this.assertActive();
    const currentSource = await captureTree(this.sourceRoot);
    const conflicts = treeConflicts(this.sourceState, currentSource);
    if (conflicts.length > 0) return { applied: [], conflicts };

    const review = await this.review();
    if (review.conflicts.length > 0) return { applied: [], conflicts: review.conflicts };
    const initialWorking = this.initialWorkspaceState;
    const currentWorking = await captureTree(this.workingDirectory);
    const changePaths = new Set(review.changes.map((change) => change.path));
    const changes = treeChanges(initialWorking, currentWorking).filter((change) => changePaths.has(change.path));
    const applied: string[] = [];

    const removeFirst = changes
      .filter(({ before, after }) => before && (!after || before.kind !== after.kind))
      .sort((a, b) => b.path.split("/").length - a.path.split("/").length);
    const createDirectories = changes
      .filter(({ after, before }) => after?.kind === "directory" && (!before || before.kind !== "directory"))
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
    const replaceFiles = changes.filter(({ after }) => after?.kind === "file");
    const replaceLinks = changes.filter(({ after }) => after?.kind === "symlink");
    const chmodDirectories = changes.filter(({ before, after }) => before?.kind === "directory" && after?.kind === "directory" && before.mode !== after.mode);

    try {
      for (const change of removeFirst) {
        await this.assertPathUnchanged(change.path, this.sourceState.get(change.path));
        const target = join(this.sourceRoot, ...change.path.split("/"));
        if (change.before?.kind === "directory") await rmdir(target);
        else await rm(target, { force: true });
        applied.push(change.path);
      }

      for (const change of createDirectories) {
        const after = change.after!;
        await this.assertPathUnchanged(change.path, applied.includes(change.path) ? undefined : this.sourceState.get(change.path));
        const target = join(this.sourceRoot, ...change.path.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await mkdir(target);
        await chmod(target, after.mode);
        applied.push(change.path);
      }

      for (const change of replaceFiles) {
        const after = change.after!;
        await this.assertPathUnchanged(change.path, applied.includes(change.path) ? undefined : this.sourceState.get(change.path));
        const source = join(this.workingDirectory, ...change.path.split("/"));
        const target = join(this.sourceRoot, ...change.path.split("/"));
        await replaceWithFile(source, target, after.mode);
        applied.push(change.path);
      }

      for (const change of replaceLinks) {
        const after = change.after!;
        await this.assertPathUnchanged(change.path, applied.includes(change.path) ? undefined : this.sourceState.get(change.path));
        const source = join(this.workingDirectory, ...change.path.split("/"));
        const target = join(this.sourceRoot, ...change.path.split("/"));
        await replaceWithSymlink(source, target, mapWorkspaceLinkTarget(after.target ?? "", this.workingDirectory, this.sourceRoot));
        applied.push(change.path);
      }

      for (const change of chmodDirectories) {
        await this.assertPathUnchanged(change.path, this.sourceState.get(change.path));
        await chmod(join(this.sourceRoot, ...change.path.split("/")), change.after!.mode);
        applied.push(change.path);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const path of [...applied].reverse()) {
        try {
          await this.restorePath(path);
        } catch (rollbackError) {
          rollbackErrors.push(`${path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback was incomplete: ${rollbackErrors.join("; ")}`);
      }
      throw error;
    }

    return { applied: changes.map((change) => change.path), conflicts: [] };
  }

  async discard(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.directory, { recursive: true, force: true });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Confirm workspace is already closed");
  }

  private async renderDiff(): Promise<{ diff: string }> {
    await rm(join(this.workingDirectory, ".git"), { recursive: true, force: true });
    try {
      const diff = await runGit(
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-renames",
          "--unified=3",
          "snapshot",
          "workspace",
        ],
        this.directory,
      );
      return {
        diff: diff
          .replaceAll("a/snapshot/", "a/")
          .replaceAll("b/workspace/", "b/"),
      };
    } catch {
      const reviewChanges = await this.reviewChangesWithoutDiff();
      return { diff: await simpleDiff(this.directory, reviewChanges) };
    }
  }

  private async reviewChangesWithoutDiff(): Promise<WorkspaceChange[]> {
    const currentWorkspace = await captureTree(this.workingDirectory);
    return publicChanges(treeChanges(this.initialWorkspaceState, currentWorkspace));
  }

  private async assertPathUnchanged(path: string, expected: FileState | undefined): Promise<void> {
    assertSafeRelativePath(path);
    const actual = await readFileState(join(this.sourceRoot, ...path.split("/")));
    if (!sameForConflict(expected, actual)) throw new WorkspaceConflictError([path]);
  }

  private async restorePath(path: string): Promise<void> {
    const original = this.sourceState.get(path);
    const target = join(this.sourceRoot, ...path.split("/"));
    await rm(target, { recursive: true, force: true });
    if (!original) return;

    const snapshot = join(this.snapshotDirectory, ...path.split("/"));
    if (original.kind === "directory") {
      await mkdir(target, { recursive: true });
      await chmod(target, original.mode);
    } else if (original.kind === "file") {
      await replaceWithFile(snapshot, target, original.mode);
    } else {
      const linkTarget = await readlink(snapshot);
      await replaceWithSymlink(snapshot, target, linkTarget);
    }
  }
}

