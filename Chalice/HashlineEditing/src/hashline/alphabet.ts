import anchorData from "./anchor-table.json";
const rawAnchors: unknown = (anchorData as { anchors?: unknown }).anchors;
if (typeof rawAnchors !== "string" || rawAnchors.length === 0 || rawAnchors.length % 4 !== 0) {
  throw new Error("[E_REGISTRY] Anchor table is missing or corrupt; reinstall pi-hashline-edit-pro.");
}
const TABLE: string = rawAnchors;
export const HASH_LEN = 4;
export const ANCHOR_COUNT = TABLE.length / HASH_LEN;
const LETTERS = "A-Za-z";

export const ALPH_RE = new RegExp(`^[${LETTERS}]+$`);

export const HASH_CLASS = `[${LETTERS}]{${HASH_LEN}}`;

export const HASH_RUN = `[${LETTERS}]{${HASH_LEN},${HASH_LEN + 1}}`;

export const HASH_RE = new RegExp(`^${HASH_CLASS}$`);

export function anchorAt(idx: number): string {
  return TABLE.slice(idx * HASH_LEN, idx * HASH_LEN + HASH_LEN);
}
