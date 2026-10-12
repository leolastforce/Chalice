/**
 * Sandbox awareness — the factual "these are your enforcement boundaries"
 * system-prompt section injected each turn.
 */

import type { ModeDef } from "./schema.ts";

export interface AwarenessOptions {
  active: boolean;
  reason?: string;
  networkOpen?: boolean;
  sessionDomains?: string[];
  scratchDir?: string;
}

function scratchSentence(dir: string): string {
  return (
    `Keep temporary files, downloads, and throwaway scripts in this session's scratch directory: ${dir} ` +
    "($TMPDIR inside bash points there) — not elsewhere under /tmp and not in the project; it is cleaned up automatically."
  );
}

function renderWritePath(p: string): string {
  return p === "." || p === "./" ? "the project directory" : p;
}

export function sandboxAwarenessPrompt(mode: ModeDef, opts: AwarenessOptions): string | undefined {
  if (mode.injectSandboxInfo === false) return undefined;
  const sb = mode.sandbox;
  if (!sb.enabled) {
    if (!opts.scratchDir) return undefined;
    return [`## Scratch directory (${mode.label})`, "", `Bash runs unsandboxed in this mode. ${scratchSentence(opts.scratchDir)}`].join("\n");
  }

  const header = `## Sandbox & permissions (${mode.label})`;

  if (!opts.active) {
    const lines = [
      header,
      "",
      `This mode normally runs bash inside an OS sandbox, but the sandbox is unavailable here${opts.reason ? ` (${opts.reason})` : ""}.`,
      "Bash commands run with full user permissions and ask for the user's confirmation instead — issue them normally",
      "and let the prompt do the gating.",
    ];
    if (opts.scratchDir) lines.push("", scratchSentence(opts.scratchDir));
    return lines.join("\n");
  }

  const lines = [header, "", "Bash runs inside an OS-level sandbox with these boundaries:", ""];

  if (!sb.writable) {
    lines.push(
      "- Bash is READ-ONLY: filesystem writes from bash fail regardless of path (no mkdir, no redirects, no installs). Use the Write/Edit tools for the file changes this mode permits.",
    );
  } else {
    const writable = (sb.allowWrite ?? []).filter((p) => p !== opts.scratchDir).map(renderWritePath);
    lines.push(
      `- Writable paths: ${writable.join(", ") || "(none)"}. Use them for installs and build output (./node_modules, an in-project venv).`,
    );
    if (opts.scratchDir) lines.push(`- ${scratchSentence(opts.scratchDir)}`);
  }
  if (sb.denyWrite?.length) {
    lines.push(`- Additionally write-denied: ${sb.denyWrite.join(", ")}.`);
  }
  if (sb.denyRead?.length) {
    lines.push(`- Reads are broadly allowed EXCEPT: ${sb.denyRead.join(", ")}.`);
    if (sb.allowRead?.length) {
      lines.push(`- Readable again inside those denied paths: ${sb.allowRead.map(renderWritePath).join(", ")}. Anything else under a denied path reads as absent.`);
    }
  }
  if (sb.network?.allowedDomains === undefined) {
    lines.push("- Network is unrestricted in this mode (no allowlist configured).");
  } else if (opts.networkOpen) {
    const denied = sb.network?.deniedDomains ?? [];
    lines.push(
      `- Network filtering is disabled for this session: all hosts are reachable from bash${denied.length ? ` except the mode's denied domains (${denied.join(", ")})` : ""}.`,
    );
  } else {
    const domains = [...new Set([...(sb.network?.allowedDomains ?? []), ...(opts.sessionDomains ?? [])])];
    const scope = domains.length
      ? `- Network is limited to these domains: ${domains.join(", ")}.`
      : "- No domains are allowlisted for bash network access.";
    lines.push(
      sb.askOnBlockedHost === false
        ? `${scope} Other hosts are silently unreachable — request access with the request_network_access tool.`
        : `${scope} A request to any other host pauses while the user is asked to allow it — if they approve, simply retry the command. To get domains approved up front (e.g. before an install that hits several hosts), call the request_network_access tool.`,
    );
  }
  lines.push(
    "- Background processes do not outlive the command: each bash call runs in its own sandbox that is torn down when the command exits, so `&`, `nohup`, and `setsid` cannot start anything long-running. Run long tasks in the foreground with an adequate timeout, or ask the user.",
    "- Commands beyond these boundaries (out-of-project paths, sudo/doas) are fine to issue: the user is asked for permission automatically, and approved commands run outside the sandbox.",
    mode.bypassProtectedPaths
      ? "- File tools (read/edit/write/…) are policy-gated rather than OS-sandboxed."
      : "- File tools (read/edit/write/…) are policy-gated rather than OS-sandboxed; writes to protected paths (.git/, .env*, dotfiles) are blocked.",
    "",
    "If a command fails with a permission or network error without a prompt having appeared, the sandbox blocked it silently — ask the user for that step instead of retrying variants.",
  );
  return lines.join("\n");
}
