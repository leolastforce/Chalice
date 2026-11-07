import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PRIVATE_ENTRY = "chalice-memory-private";

export function isMemoryPrivate(ctx: ExtensionContext): boolean {
	let value = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === PRIVATE_ENTRY && typeof entry.data === "boolean") value = entry.data;
	}
	return value;
}
