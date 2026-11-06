import type { Memory } from "./store.ts";

// Bound serialized data, not just entry count: JSON escaping and Unicode add bytes.
export const MEMORY_MAX_BYTES = 16_000;
export const MEMORY_MAX_ENTRIES = 40;

type PromptMemory = Pick<Memory, "id" | "scope" | "text">;

export function selectMemories(memories: readonly Memory[]): { selected: PromptMemory[]; omitted: Memory[] } {
	const ordered = [...memories].sort((a, b) => {
		if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
		return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
	});
	const selected: PromptMemory[] = [];
	const omitted: Memory[] = [];
	let bytes = 2; // JSON array brackets
	for (const memory of ordered) {
		const item: PromptMemory = { id: memory.id, scope: memory.scope, text: memory.text };
		const size = Buffer.byteLength(JSON.stringify(item), "utf8") + (selected.length ? 1 : 0);
		if (selected.length >= MEMORY_MAX_ENTRIES || bytes + size > MEMORY_MAX_BYTES) {
			omitted.push(memory);
			continue;
		}
		selected.push(item);
		bytes += size;
	}
	return { selected, omitted };
}
