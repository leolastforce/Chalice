/**
 * Small shared types that aren't part of the mode schema itself.
 *
 * Mode definitions, labels, colors and the cycle order live in `schema.ts`.
 * This module holds persisted session state.
 */

/** Persisted per-session so the mode survives reload / resume / tree navigation. */
export interface PermState {
  /** A mode name; validated against the loaded config's `modes` on restore. */
  mode: string;
  /** Whether debug implementing permissions are currently granted (debug mode only). */
  debugImplementingPermissions?: boolean;
}
