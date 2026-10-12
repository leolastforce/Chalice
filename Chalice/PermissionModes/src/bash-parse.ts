/**
 * Bash command analysis via tree-sitter (real AST), with a regex fallback.
 */

import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import Parser from "web-tree-sitter";
import { bashConfirmReason, normalizeBashToken, pathPartOfToken, PRIVILEGE_RE, tokenTarget } from "./heuristics.ts";
import { bashPathEscapes, SAFE_OUTSIDE_RE } from "./paths.ts";

export interface BashCommand {
  name: string;
  args: string[];
  isNested: boolean;
  heredoc?: string;
  aliases?: string[];
  pathTokens?: string[];
}

export interface SyntaxNodeLike {
  type: string;
  text: string;
  children: SyntaxNodeLike[];
}

const NESTING = new Set(["command_substitution", "subshell", "process_substitution"]);
const ARG_TYPES = new Set([
  "word",
  "string",
  "raw_string",
  "ansi_c_string",
  "concatenation",
  "number",
  "simple_expansion",
  "expansion",
]);

function stripQuotes(s: string): string {
  return s.replace(/^['"]+|['"]+$/g, "");
}

function redirectTarget(node: SyntaxNodeLike): string | undefined {
  for (const c of node.children ?? []) {
    if (ARG_TYPES.has(c.type)) return stripQuotes(c.text);
  }
  return undefined;
}

function parseCommand(node: SyntaxNodeLike, isNested: boolean): BashCommand {
  let name = "";
  const args: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type === "command_name") {
      if (!name) name = child.text.trim();
    } else if (ARG_TYPES.has(child.type)) {
      args.push(stripQuotes(child.text));
    } else if (child.type === "file_redirect") {
      const t = redirectTarget(child);
      if (t !== undefined) args.push(t);
    }
  }
  return { name, args, isNested };
}

function collectWords(node: SyntaxNodeLike, out: string[] = []): string[] {
  for (const c of node.children ?? []) {
    if (ARG_TYPES.has(c.type)) out.push(stripQuotes(c.text));
    else collectWords(c, out);
  }
  return out;
}

export function extractCommands(root: SyntaxNodeLike): BashCommand[] {
  const out: BashCommand[] = [];
  const walk = (node: SyntaxNodeLike, nested: boolean) => {
    const inNest = nested || NESTING.has(node.type);
    if (node.type === "redirected_statement") {
      const kids = node.children ?? [];
      const cmdNode = kids.find((c) => c.type === "command");
      if (cmdNode) {
        const cmd = parseCommand(cmdNode, inNest);
        for (const c of kids) {
          if (c.type === "file_redirect") {
            const t = redirectTarget(c);
            if (t !== undefined) cmd.args.push(t);
          } else if (c.type === "heredoc_redirect") {
            const body = (c.children ?? []).find((h) => h.type === "heredoc_body");
            if (body) cmd.heredoc = body.text;
          }
        }
        out.push(cmd);
        for (const c of cmdNode.children ?? []) walk(c, inNest);
        for (const c of kids) {
          if (c === cmdNode) continue;
          if (c.type === "file_redirect" || c.type === "heredoc_redirect") {
            for (const w of c.children ?? []) for (const g of w.children ?? []) walk(g, inNest);
          } else {
            walk(c, inNest);
          }
        }
        return;
      }
    }
    if (node.type === "command") out.push(parseCommand(node, inNest));
    else if (node.type === "file_redirect") {
      const t = redirectTarget(node);
      if (t !== undefined) out.push({ name: "", args: [t], isNested: true });
    } else if (node.type === "test_command") {
      out.push({ name: "[[", args: collectWords(node), isNested: inNest });
    }
    for (const c of node.children ?? []) walk(c, inNest);
  };
  walk(root, false);
  return out;
}

const WRAPPER_COMMANDS = new Set([
  "env",
  "command",
  "nice",
  "ionice",
  "nohup",
  "setsid",
  "stdbuf",
  "timeout",
  "time",
  "xargs",
  "exec",
  "builtin",
  "coproc",
]);

const EXEC_FLAG_COMMANDS: Record<string, Set<string>> = {
  find: new Set(["-exec", "-execdir", "-ok", "-okdir"]),
  fd: new Set(["-x", "--exec", "-X", "--exec-batch"]),
  fdfind: new Set(["-x", "--exec", "-X", "--exec-batch"]),
};

const SKIPPABLE_WRAPPER_ARG = /^(-|\w+=|\d+$)/;

export function unwrapCommand(c: { name: string; args: string[] }): { name: string; args: string[] } {
  let head = c.name;
  let rest = c.args;
  for (let hops = 0; hops < 8; hops++) {
    const base = path.basename(head);
    const execFlags = EXEC_FLAG_COMMANDS[base];
    if (execFlags) {
      const idx = rest.findIndex((a) => execFlags.has(a));
      if (idx === -1 || idx + 1 >= rest.length) return { name: head, args: rest };
      head = rest[idx + 1]!;
      rest = rest.slice(idx + 2);
      continue;
    }
    if (!WRAPPER_COMMANDS.has(base)) return { name: head, args: rest };
    const idx = rest.findIndex((a) => !SKIPPABLE_WRAPPER_ARG.test(a));
    if (idx === -1) return { name: head, args: rest };
    head = rest[idx]!;
    rest = rest.slice(idx + 1);
  }
  return { name: head, args: rest };
}

export function isPrivilegeEscalation(c: BashCommand): boolean {
  let cur: { name: string; args: string[] } = c;
  for (let hops = 0; hops < 8; hops++) {
    if (PRIVILEGE_RE.test(path.basename(cur.name))) return true;
    const next = unwrapCommand(cur);
    if (next.name === cur.name && next.args === cur.args) return false;
    cur = next;
  }
  return false;
}

export function policyAliases(c: BashCommand): string[] {
  const out = new Set<string>();
  const joined = (n: string, a: string[]) => [n, ...a].join(" ").trim();
  const original = joined(c.name, c.args);
  const norm = { name: normalizeBashToken(c.name), args: c.args.map(normalizeBashToken) };
  for (const v of [c, norm]) {
    const j = joined(v.name, v.args);
    if (j !== original) out.add(j);
    const base = path.basename(v.name);
    if (base !== v.name) out.add(joined(base, v.args));
    const inner = unwrapCommand(v);
    if (inner.name !== v.name) {
      out.add(joined(inner.name, inner.args));
      const innerBase = path.basename(inner.name);
      if (innerBase !== inner.name) out.add(joined(innerBase, inner.args));
    }
  }
  return [...out];
}

const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_OPTS_WITH_VALUE = new Set(["-o", "-O", "+o", "+O", "--rcfile", "--init-file"]);

function shellScript(c: BashCommand): string | undefined {
  const base = path.basename(c.name);
  if (base === "eval") return c.args.join(" ") || undefined;
  if (!SHELL_COMMANDS.has(base)) return undefined;
  let sawC = false;
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i]!;
    if (a === "--") {
      const next = c.args[i + 1];
      return sawC && next !== undefined ? next : c.heredoc;
    }
    if (SHELL_OPTS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-") || a.startsWith("+")) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) sawC = true;
      continue;
    }
    if (sawC) return a;
    return a === "-" ? c.heredoc : undefined;
  }
  return c.heredoc;
}

export function expandShellCommands(
  parse: (script: string) => BashCommand[],
  commands: BashCommand[],
  depth = 0,
): BashCommand[] {
  if (depth >= 3) return commands;
  const out: BashCommand[] = [];
  for (const c of commands) {
    out.push(c);
    const script = shellScript(c);
    if (!script) continue;
    let inner: BashCommand[] = [];
    try {
      inner = parse(script).map((i) => ({ ...i, isNested: true }));
    } catch {
      // unparsable
    }
    out.push(...expandShellCommands(parse, inner, depth + 1));
  }
  return out;
}

const DIR_CHANGERS = new Set(["cd", "pushd"]);

export function outsideReasonFromCommands(
  commands: BashCommand[],
  root: string,
  alsoInside: readonly string[] = [],
): string | undefined {
  for (const c of commands) {
    if (isPrivilegeEscalation(c)) return "privilege escalation";
    if (DIR_CHANGERS.has(path.basename(c.name))) {
      const dest = c.args.find((a) => a === "-" || !a.startsWith("-"));
      if (dest === undefined || dest === "-") return `path outside project: ${c.name} ${dest ?? ""}`.trim();
    }
    for (const [i, raw] of [c.name, ...c.args].entries()) {
      const tok = normalizeBashToken(raw);
      if (/^~[^/]/.test(tok)) return `path outside project: ${raw}`;
      const target = tokenTarget(tok, root, i > 0);
      if (target === undefined || SAFE_OUTSIDE_RE.test(target)) continue;
      if (bashPathEscapes(root, target, alsoInside)) return `path outside project: ${raw}`;
    }
  }
  return undefined;
}

export function escapingPaths(commands: BashCommand[], root: string, alsoInside: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const c of commands) {
    for (const [i, raw] of [c.name, ...c.args].entries()) {
      const tok = normalizeBashToken(raw);
      if (/^~[^/]/.test(tok)) continue;
      const target = tokenTarget(tok, root, i > 0);
      if (target === undefined || SAFE_OUTSIDE_RE.test(target)) continue;
      if (bashPathEscapes(root, target, alsoInside)) out.add(path.resolve(target));
    }
  }
  return [...out];
}

export function escapeTargetFromReason(reason: string | undefined, root: string): string | undefined {
  const m = reason?.match(/^path outside project: (.+)$/);
  if (!m) return undefined;
  const p = pathPartOfToken(normalizeBashToken(m[1]!));
  if (/^~[^/]/.test(p) || /^(cd|pushd)\b/.test(p)) return undefined;
  if (p.startsWith("/")) return p;
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(root, p);
}

export interface BashParser {
  parse(command: string): BashCommand[];
}

let parserPromise: Promise<BashParser | undefined> | undefined;

async function initParser(): Promise<BashParser | undefined> {
  try {
    const require = createRequire(import.meta.url);
    let bashWasm: string;
    try {
      const wasmDir = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
      bashWasm = path.join(wasmDir, "tree-sitter-bash.wasm");
    } catch {
      bashWasm = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
    }
    await Parser.init();
    const lang = await Parser.Language.load(bashWasm);
    const parser = new Parser();
    parser.setLanguage(lang);
    return {
      parse: (command: string) => {
        const tree = parser.parse(command);
        return tree ? extractCommands(tree.rootNode as unknown as SyntaxNodeLike) : [];
      },
    };
  } catch {
    return undefined;
  }
}

export function getTreeSitterParser(): Promise<BashParser | undefined> {
  parserPromise ??= initParser();
  return parserPromise;
}

export interface BashAnalysis {
  commands: BashCommand[];
  outsideReason: string | undefined;
  usedFallback: boolean;
}

export async function analyzeBash(command: string, root: string, alsoInside: readonly string[] = []): Promise<BashAnalysis> {
  const parser = await getTreeSitterParser();
  if (parser) {
    try {
      const commands = expandShellCommands((s) => parser.parse(s), parser.parse(command)).map((c) => {
        const aliases = policyAliases(c);
        const raw = [c.name, ...c.args];
        const pathTokens = [...new Set(raw.map(normalizeBashToken).filter((t) => !raw.includes(t)))];
        return { ...c, ...(aliases.length ? { aliases } : {}), ...(pathTokens.length ? { pathTokens } : {}) };
      });
      return { commands, outsideReason: outsideReasonFromCommands(commands, root, alsoInside), usedFallback: false };
    } catch {
      // fallback
    }
  }
  return { commands: [], outsideReason: bashConfirmReason(command, root, alsoInside), usedFallback: true };
}
