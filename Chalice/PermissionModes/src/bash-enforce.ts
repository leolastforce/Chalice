/**
 * Bash enforcement — composes the policy action for a bash command with the
 * mode's sandbox profile and the live sandbox readiness into a concrete plan.
 */

import type { Action } from "./schema.ts";

export type BashGateKind = "allow" | "prompt" | "block";

export interface BashGate {
  kind: BashGateKind;
  /** Prompt title (when kind === "prompt"). */
  title: string;
  /** Block reason (when kind === "block"). */
  reason: string;
  /** When prompting: run UNSANDBOXED once approved (escapes & degraded fallback). */
  onApproveUnsandboxed: boolean;
}

export function bashGate(
  action: Action,
  outsideReason: string | undefined,
  sandboxEnabled: boolean,
  sandboxReady: boolean,
): BashGate {
  if (action === "deny") {
    return {
      kind: "block",
      title: "",
      reason: "bash command denied by policy",
      onApproveUnsandboxed: false,
    };
  }

  if (!sandboxEnabled) {
    if (action === "ask") {
      return {
        kind: "prompt",
        title: "Allow bash? (sandbox disabled; command will run unsandboxed)",
        reason: "bash blocked",
        onApproveUnsandboxed: true,
      };
    }
    return {
      kind: "allow",
      title: "",
      reason: "",
      onApproveUnsandboxed: false,
    };
  }

  if (outsideReason) {
    return {
      kind: "prompt",
      title: `Allow bash? (${outsideReason})`,
      reason: "bash blocked",
      onApproveUnsandboxed: true,
    };
  }

  if (!sandboxReady) {
    return {
      kind: "prompt",
      title: "Allow bash? (sandbox unavailable)",
      reason: "bash blocked",
      onApproveUnsandboxed: true,
    };
  }

  if (action === "ask") {
    return {
      kind: "prompt",
      title: "Allow bash?",
      reason: "bash blocked",
      onApproveUnsandboxed: false,
    };
  }
  return {
    kind: "allow",
    title: "",
    reason: "",
    onApproveUnsandboxed: false,
  };
}

export interface BashExecPlan {
  sandboxed: boolean;
  readOnly: boolean;
}

export function bashExecPlan(
  sandboxEnabled: boolean,
  sandboxWritable: boolean,
  sandboxReady: boolean,
  approvedUnsandboxed: boolean,
): BashExecPlan {
  return {
    sandboxed: sandboxEnabled && sandboxReady && !approvedUnsandboxed,
    readOnly: !sandboxWritable,
  };
}
