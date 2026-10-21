/**
 * OS-level sandbox lifecycle.
 *
 * Wraps `@anthropic-ai/sandbox-runtime` behind a `SandboxController`
 * that owns init / wrap / reset and readiness state.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { type SandboxConfig, profileToConfig, readOnlyOverride } from "./config-load.ts";
import { gitDirsOf } from "./paths.ts";
import { expandHome } from "./resolve.ts";
import type { SandboxProfile } from "./schema.ts";

const SANDBOX_MOUNT_ARTIFACTS = [".claude", ".claude/commands", ".claude/agents", ".vscode", ".idea", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".gitconfig", ".gitmodules", ".ripgreprc", ".mcp.json"] as const;

/** Remove stale /dev/null mount points left by older bubblewrap sandbox versions. */
function repairSandboxMountArtifacts(cwd: string): void {
  if (process.platform !== "linux") return;

  let nullDevice: number;
  try {
    nullDevice = statSync("/dev/null").rdev;
  } catch {
    return;
  }

  const containerPaths = new Set([".claude", ".vscode", ".idea"]);
  for (const relative of SANDBOX_MOUNT_ARTIFACTS) {
    const target = path.join(cwd, relative);
    try {
      const entry = lstatSync(target);
      const isContainer = containerPaths.has(relative);
      const isNullMount = entry.isCharacterDevice() && entry.rdev === nullDevice;
      const isStaleContainerFile = isContainer && entry.isFile() && entry.size === 0 && (entry.mode & 0o222) === 0;
      if (!isNullMount && !isStaleContainerFile) continue;
      rmSync(target, { force: true });
      if (isContainer) {
        mkdirSync(target, { recursive: true, mode: 0o755 });
      }
    } catch {
      // Stale sandbox artifacts are best-effort cleanup targets.
    }
  }
}
function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}


type SandboxManagerType = typeof SandboxManager;

const EXTENSION_DIR = fileURLToPath(new URL("..", import.meta.url));

const LAUNCHER_UNSAFE = /['!"$`\\]/;

export function commandLauncher(file: string, tmpdir?: string): string | undefined {
  if (LAUNCHER_UNSAFE.test(file) || /[\r\n]/.test(file)) return undefined;
  const prefix = tmpdir && !LAUNCHER_UNSAFE.test(tmpdir) && !/[\r\n]/.test(tmpdir) ? `TMPDIR="${tmpdir}" ` : "";
  return `${prefix}bash -c "$(<"${file}")"`;
}

let commandDir: string | undefined;

function commandFileDir(): string | undefined {
  if (commandDir) return commandDir;
  const base = process.platform === "win32" ? os.tmpdir() : "/tmp";
  for (const b of [base, os.tmpdir()]) {
    try {
      commandDir = mkdtempSync(path.join(b, "pi-permission-mode-"));
      return commandDir;
    } catch {
      // try next
    }
  }
  return undefined;
}

export function writeCommandFile(command: string, dir: string | undefined = commandFileDir()): string | undefined {
  if (!dir) return undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `cmd-${randomBytes(8).toString("hex")}.sh`);
    writeFileSync(file, command, { mode: 0o600 });
    return file;
  } catch {
    return undefined;
  }
}

class StderrHead {
  private text = "";
  add(chunk: Buffer | string): void {
    if (this.text.length < 4096) this.text += String(chunk).slice(0, 4096 - this.text.length);
  }
  namespaceHint(): string | undefined {
    const first = this.text.split("\n", 1)[0] ?? "";
    if (!/^bwrap: .*(Operation not permitted|Permission denied|No permissions to create)/i.test(first)) return undefined;
    return (
      "\n[permission-mode] sandbox: bubblewrap could not set up its namespaces, so the command did not run. " +
      "On Ubuntu 24.04+ (also under WSL2) this usually means kernel.apparmor_restrict_unprivileged_userns=1; " +
      "see README. Nothing ran unsandboxed.\n"
    );
  }
}

function runError(err: unknown): Error {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (e && typeof e === "object" && e.name === "LinuxSandboxProfileError" && typeof e.code === "string") {
    return new Error(`sandbox profile error (${e.code}): ${String(e.message)}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

const MONITOR_NOISE = /^deny \S+ \/(dev|proc)\//;
const GRANTABLE_NET_DENY = /^deny network-outbound (.+):\d+ \((user denied|host is not on the allow list)\)$/;

export function processViolations(block: string): { block: string; grantableHosts: string[] } {
  const m = /^<sandbox_violations>\r?\n([\s\S]*?)\r?\n?<\/sandbox_violations>$/.exec(block.trim());
  if (!m) return { block: block.trim(), grantableHosts: [] };
  const lines = m[1]!.split(/\r?\n/).filter((l) => l.trim() && !MONITOR_NOISE.test(l));
  const hosts = new Set<string>();
  for (const l of lines) {
    const h = GRANTABLE_NET_DENY.exec(l);
    if (h) hosts.add(h[1]!.replace(/^\[|\]$/g, ""));
  }
  return { block: lines.length ? `<sandbox_violations>\n${lines.join("\n")}\n</sandbox_violations>` : "", grantableHosts: [...hosts] };
}

export function createSandboxedBashOps(
  manager: SandboxManagerType,
  customConfig?: Partial<SandboxConfig>,
  runOpts: {
    tmpdir?: string;
    onRun?: () => () => void;
  } = {},
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      if (signal?.aborted) throw new Error("aborted");

      const commandFile = writeCommandFile(command);
      const launcher = commandFile ? commandLauncher(commandFile, runOpts.tmpdir) : undefined;
      const commandId = `pi-${randomBytes(8).toString("hex")}`;
      const emitViolations = () => {
        let raw = "";
        try {
          raw = manager.annotateStderrWithSandboxFailures?.(commandId, "")?.trim() ?? "";
        } catch {
          return;
        }
        const { block, grantableHosts } = processViolations(raw);
        if (block) onData(Buffer.from(`\n${block}\n`));
        if (grantableHosts.length > 0) {
          onData(
            Buffer.from(
              `\n[permission-mode] network: connection(s) blocked by the sandbox allowlist: ${grantableHosts.join(", ")}. ` +
                "Request access with the request_network_access tool, or ask the user (/net allow <domain>).\n",
            ),
          );
        }
      };

      let wrapped: string;
      try {
        wrapped = await manager.wrapWithSandbox(launcher ?? command, undefined, customConfig as never, signal as never);
      } catch (err) {
        if (commandFile) rmSync(commandFile, { force: true });
        throw runError(err);
      }

      const runDone = runOpts.onRun?.();
      try {
        if (signal?.aborted) throw new Error("aborted");
        const head = new StderrHead();
        const { promise, resolve, reject } = withResolvers<{ exitCode: number | null }>();
        const child = spawn("bash", ["-c", wrapped], { cwd, env: env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const kill = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        if (timeout && timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeout * 1000);
        }
        child.stdout?.on("data", onData);
        child.stderr?.on("data", (chunk: Buffer) => {
          head.add(chunk);
          onData(chunk);
        });
        const onAbort = () => kill();
        child.on("error", (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) kill();
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          setImmediate(() => {
            emitViolations();
            if (code !== 0) {
              const hint = head.namespaceHint();
              if (hint) onData(Buffer.from(hint));
            }
            if (signal?.aborted) reject(new Error("aborted"));
            else if (timedOut) reject(new Error(`timeout:${timeout}`));
            else resolve({ exitCode: code });
          });
        });
        return await promise;
      } finally {
        try {
          (manager as unknown as { cleanupAfterCommand?: () => void }).cleanupAfterCommand?.();
        } catch {
          // ignore
        }
        repairSandboxMountArtifacts(cwd);
        runDone?.();
        if (commandFile) rmSync(commandFile, { force: true });
      }
    },
  };
}

export function networkFiltered(profile: SandboxProfile): boolean {
  return profile.enabled && profile.network?.allowedDomains !== undefined;
}

export function withDeniedReads(profile: SandboxProfile, paths: readonly string[]): SandboxProfile {
  if (!profile.enabled || paths.length === 0) return profile;
  const out: SandboxProfile = { ...profile, denyRead: [...new Set([...(profile.denyRead ?? []), ...paths])] };
  if (profile.allowRead?.length) {
    const blocked = paths.map((b) => path.resolve(expandHome(b)));
    out.allowRead = profile.allowRead.filter((a) => {
      const abs = path.resolve(expandHome(a));
      return !blocked.some((b) => abs === b || abs.startsWith(b + path.sep));
    });
  }
  return out;
}

export interface BashOpsOptions {
  readOnly?: boolean;
  keepWritable?: string[];
  extraDenyRead?: readonly string[];
  tmpdir?: string;
}

export interface RuntimeExtras {
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

export function runtimeInstallDir(): string | undefined {
  try {
    return path.dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime/package.json")));
  } catch {
    return undefined;
  }
}

export function commandFilesDir(): string | undefined {
  return commandFileDir();
}

export function runtimeExtrasFor(cwd: string, runtimeDir: string | undefined = runtimeInstallDir()): RuntimeExtras {
  const extras: RuntimeExtras = { allowRead: runtimeDir ? [runtimeDir] : [], allowWrite: [], denyWrite: [] };
  const gitfile = path.join(cwd, ".git");
  try {
    if (lstatSync(gitfile).isFile()) extras.denyWrite.push(gitfile);
  } catch {
    // absent
  }
  const git = gitDirsOf(cwd);
  if (git) {
    for (const d of new Set([git.gitdir, git.commondir])) {
      extras.allowWrite.push(d);
      for (const f of ["hooks", "config", "config.worktree", "gitdir", "commondir"]) {
        if (existsSync(path.join(d, f))) extras.denyWrite.push(path.join(d, f));
      }
    }
  }
  return extras;
}

export function withRuntimeExtras(cfg: SandboxConfig, extras: RuntimeExtras | undefined): SandboxConfig {
  if (!extras) return cfg;
  const merge = (a: readonly string[] | undefined, b: readonly string[]): string[] => [...new Set([...(a ?? []), ...b])];
  const fs = { ...cfg.filesystem, allowWrite: merge(cfg.filesystem.allowWrite, extras.allowWrite), denyWrite: merge(cfg.filesystem.denyWrite, extras.denyWrite) };
  const allowRead = merge(cfg.filesystem.allowRead, extras.allowRead);
  return { ...cfg, filesystem: allowRead.length > 0 ? { ...fs, allowRead } : fs };
}

export function bashCustomConfig(profile: SandboxProfile, opts: BashOpsOptions, extras?: RuntimeExtras): SandboxConfig | undefined {
  const extra = opts.extraDenyRead ?? [];
  if (!opts.readOnly && extra.length === 0) return undefined;
  const base = withRuntimeExtras(profileToConfig(withDeniedReads(profile, extra)), extras);
  return opts.readOnly ? readOnlyOverride(base, opts.keepWritable ?? []) : base;
}

type Notify = (message: string) => void;

export interface InitOptions {
  cwd: string;
  noSandbox: boolean;
  hasUI: boolean;
  notify: Notify;
  profile: SandboxProfile;
  askHost?: (host: string, port: number | undefined) => Promise<boolean>;
}

export class SandboxController {
  private manager: SandboxManagerType | null = null;
  private profile: SandboxProfile | undefined;
  private appliedKey: string | undefined;
  private runtimeInitialized = false;
  private applying: Promise<void> = Promise.resolve();
  private degraded = false;
  private hasUI = false;
  private notifyFn: Notify = () => {};
  private askHost: ((host: string, port: number | undefined) => Promise<boolean>) | undefined;
  ready = false;
  disabled = false;
  warn: string | undefined;
  dependencyWarnings: string[] = [];
  extras: RuntimeExtras | undefined;

  get sandboxManager(): SandboxManagerType | null {
    return this.manager;
  }

  bashOps(opts: BashOpsOptions = {}): BashOperations | null {
    if (!this.manager || !this.profile) return null;
    return createSandboxedBashOps(this.manager, bashCustomConfig(this.profile, opts, this.extras), {
      tmpdir: opts.tmpdir,
      onRun: () => this.runStarted(),
    });
  }

  private inflight = 0;
  private idleWaiters: Array<() => void> = [];

  private runStarted(): () => void {
    this.inflight++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inflight--;
      if (this.inflight === 0) for (const w of this.idleWaiters.splice(0)) w();
    };
  }

  private whenIdle(): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    const { promise, resolve } = withResolvers<void>();
    this.idleWaiters.push(resolve);
    return promise;
  }

  private static installHint(): string {
    const linux = process.platform === "linux" ? "  (Linux also needs: bubblewrap, socat, ripgrep)" : "";
    return `Fix: cd ${EXTENSION_DIR} && npm install${linux}`;
  }

  async init({ cwd, noSandbox, hasUI, notify, profile, askHost }: InitOptions): Promise<void> {
    await this.applying.catch(() => {});
    if (this.runtimeInitialized && this.manager) {
      try {
        await this.manager.reset();
      } catch {
        // ignore
      }
      this.runtimeInitialized = false;
    }
    this.ready = false;
    this.disabled = false;
    this.degraded = false;
    this.warn = undefined;
    this.manager = null;
    this.appliedKey = undefined;
    this.dependencyWarnings = [];
    this.extras = runtimeExtrasFor(cwd);
    this.hasUI = hasUI;
    this.notifyFn = notify;
    this.askHost = askHost;
    repairSandboxMountArtifacts(cwd);

    if (noSandbox) {
      this.disabled = true;
      this.degraded = true;
      this.profile = profile;
      return;
    }
    if (process.platform === "win32") {
      this.warn = "sandbox unsupported on Windows (run pi under WSL2)";
      this.degraded = true;
      this.profile = profile;
      return;
    }

    try {
      this.manager = SandboxManager;
    } catch (err) {
      this.degraded = true;
      this.profile = profile;
      this.warn = `sandbox load failed: ${err instanceof Error ? err.message : String(err)}`;
      if (hasUI) {
        notify(
          `permission-mode: OS sandbox unavailable - protection is heuristic-only.\n${this.warn}\n` +
            SandboxController.installHint(),
        );
      }
      return;
    }

    if (!this.manager.isSupportedPlatform()) {
      this.warn = `sandbox unsupported on this platform${process.platform === "linux" ? " (WSL1?)" : ""}`;
      this.degraded = true;
      this.profile = profile;
      if (hasUI) notify(`permission-mode: OS sandbox unavailable - protection is heuristic-only.\n${this.warn}`);
      return;
    }

    let depsOk = false;
    try {
      const dependencyCheck = this.manager.checkDependencies();
      depsOk = dependencyCheck.errors.length === 0;
      if (dependencyCheck.warnings.length > 0 && !this.warn) {
        this.warn = dependencyCheck.warnings.join("; ");
      }
    } catch (err) {
      this.warn = `sandbox dependencies: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!depsOk) {
      this.degraded = true;
      this.profile = profile;
      if (!this.warn) this.warn = "sandbox dependencies check failed";
      if (hasUI) {
        notify(
          `permission-mode: OS sandbox unavailable - protection is heuristic-only.\n${this.warn}\n` +
            SandboxController.installHint(),
        );
      }
      return;
    }
    this.dependencyWarnings = [];

    if (this.extras?.allowWrite.length && hasUI) {
      notify(
        `permission-mode: git worktree/submodule detected; sandboxed bash may write its git dirs (${this.extras.allowWrite.join(", ")}), hooks and config excluded`,
      );
    }

    await this.applyProfile(profile);
  }

  async applyProfile(profile: SandboxProfile): Promise<void> {
    this.profile = profile;
    const run = this.applying.then(() => this.applyProfileNow(profile));
    this.applying = run.catch(() => {});
    return run;
  }

  private async applyProfileNow(profile: SandboxProfile): Promise<void> {
    if (this.degraded || !this.manager) return;
    if (!profile.enabled) return;

    const cfg = withRuntimeExtras(profileToConfig(profile), this.extras);
    const key = JSON.stringify({ n: cfg.network, f: cfg.filesystem });
    if (this.ready && key === this.appliedKey) return;

    if (this.inflight > 0) {
      if (this.hasUI) this.notifyFn(`permission-mode: waiting for ${this.inflight} running sandboxed command(s) before applying the new sandbox profile`);
      await this.whenIdle();
    }
    try {
      if (this.runtimeInitialized) {
        await this.manager.reset();
        this.runtimeInitialized = false;
      }
      const ask = this.askHost;
      await this.manager.initialize(
        cfg as never,
        ask ? (p: { host: string; port?: number }) => ask(p.host, p.port) : undefined,
        true,
      );
      this.runtimeInitialized = true;
      this.ready = true;
      this.appliedKey = key;
      this.warn = undefined;
    } catch (err) {
      this.ready = false;
      try {
        await this.manager.reset();
      } catch {
        // ignore
      }
      this.runtimeInitialized = false;
      this.warn = `sandbox init failed: ${err instanceof Error ? err.message : String(err)}`;
      if (this.hasUI) {
        this.notifyFn(
          `permission-mode: sandbox failed to initialize - protection is heuristic-only.\n${this.warn}` +
            `${process.platform === "linux" ? "\nLinux requires: bubblewrap, socat, ripgrep" : ""}`,
        );
      }
    }
  }

  async reset(): Promise<void> {
    await this.applying.catch(() => {});
    if (this.runtimeInitialized && this.manager) {
      try {
        await this.manager.reset();
      } catch {
        // ignore
      }
    }
    this.runtimeInitialized = false;
    this.ready = false;
  }
}
