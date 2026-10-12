/**
 * Bash command heuristics.
 */

import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashPathEscapes, SAFE_OUTSIDE_RE } from "./paths.ts";

export const PRIVILEGE_RE = /\b(sudo|su|doas|pkexec|runuser|setpriv|chroot)\b/i;

export function normalizeBashToken(raw: string): string {
  let t = raw;
  if (t.startsWith("$'")) t = t.slice(2).replace(/'$/, "");
  t = t.replace(/\\(.)/g, "$1");
  t = t.replace(/["']/g, "");
  const home = os.homedir();
  t = t.replace(/^\$\{HOME\}|^\$HOME(?=$|\/)/, home);
  return t;
}

export function pathPartOfToken(tok: string): string {
  const eq = tok.match(/^-{0,2}[A-Za-z0-9_.-]+=(.+)$/);
  if (eq) return eq[1];
  if (tok.startsWith("-") && tok.includes("/")) return tok.slice(tok.indexOf("/"));
  return tok;
}

export function tokenTarget(tok: string, root: string, bare: boolean): string | undefined {
  const p = pathPartOfToken(tok);
  if (p.startsWith("/")) return p;
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  if (p.includes("/") || p === "..") return path.resolve(root, p);
  if (!bare || !p || p.startsWith("-") || p === "." || /[*?[\]{}$`\0]/.test(p)) return undefined;
  try {
    return lstatSync(path.join(root, p)).isSymbolicLink() ? path.resolve(root, p) : undefined;
  } catch {
    return undefined;
  }
}

export function bashConfirmReason(command: string, root: string, alsoInside: readonly string[] = []): string | undefined {
  if (PRIVILEGE_RE.test(command)) return "privilege escalation";
  if (/(^|[;&|(]\s*)(cd|pushd)(\s+-)?\s*($|[;&|)])/.test(command)) return "path outside project: cd";
  for (const raw of command.split(/[\s;|&()<>]+/).filter(Boolean)) {
    const tok = normalizeBashToken(raw);
    if (!tok) continue;
    if (/^~[^/]/.test(tok)) return `path outside project: ${raw}`;
    const target = tokenTarget(tok, root, true);
    if (target === undefined || SAFE_OUTSIDE_RE.test(target)) continue;
    if (bashPathEscapes(root, target, alsoInside)) return `path outside project: ${raw}`;
  }
  return undefined;
}
