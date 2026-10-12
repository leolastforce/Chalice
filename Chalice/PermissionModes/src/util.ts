/**
 * Small dependency-free utilities.
 */

/** True when an error is a "module/package not found" failure (any of Node's spellings). */
export function isModuleNotFound(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return (
    e?.code === "ERR_MODULE_NOT_FOUND" ||
    e?.code === "MODULE_NOT_FOUND" ||
    /cannot find (module|package)/i.test(e?.message ?? "")
  );
}
