import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import memoryExtension from "../../../Chalice/Memory/index.ts";
import { MEMORY_MAX_BYTES, MEMORY_MAX_ENTRIES, selectMemories } from "../../../Chalice/Memory/selection.ts";
import { MemoryStore } from "../../../Chalice/Memory/store.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";

const dirs: string[] = [];
const previous = process.env.CHALICE_CODING_AGENT_DIR;
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (previous === undefined) delete process.env.CHALICE_CODING_AGENT_DIR;
	else process.env.CHALICE_CODING_AGENT_DIR = previous;
});
function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "chalice-memory-"));
	dirs.push(dir);
	return dir;
}

describe("saved memory", () => {
	it("deletes only a unique literal match and preserves ID-based deletion", async () => {
		const dir = directory();
		process.env.CHALICE_CODING_AGENT_DIR = dir;
		const store = new MemoryStore(dir, "/first");
		const global = store.save("Remember Miro likes ramen", "global");
		const project = store.save("Miro project notes", "project");
		const hidden = new MemoryStore(dir, "/other").save("Miro hidden notes", "project");
		let execute:
			| ((
					id: string,
					params: { action: "delete"; text?: string; id?: string; scope?: "global" | "project" },
					signal: undefined,
					update: undefined,
					ctx: ExtensionContext,
			  ) => Promise<{ content: { text: string }[] }>)
			| undefined;
		const pi = {
			on: () => {},
			registerCommand: () => {},
			registerTool: (tool: { execute: typeof execute }) => {
				execute = tool.execute;
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: "/first",
			isProjectTrusted: () => false,
			sessionManager: { getBranch: () => [] },
			hasUI: true,
			ui: { notify: vi.fn() },
		} as unknown as ExtensionContext;
		memoryExtension(pi);
		if (!execute) throw new Error("memory tool missing");
		const run = (params: { action: "delete"; text?: string; id?: string; scope?: "global" | "project" }) =>
			execute!("call", params, undefined, undefined, ctx);
		const ambiguous = await run({ action: "delete", text: "miro" });
		expect(ambiguous.content[0]?.text).toContain("none deleted");
		expect(ambiguous.content[0]?.text).toContain(global.id);
		expect(ambiguous.content[0]?.text).toContain(project.id);
		expect(ambiguous.content[0]?.text).not.toContain(hidden.id);
		expect(store.list()).toHaveLength(2);
		expect((await run({ action: "delete", text: "missing" })).content[0]?.text).toContain("No memory was deleted");
		await expect(run({ action: "delete", text: "  " })).rejects.toThrow("must not be empty");
		await expect(run({ action: "delete", text: "miro", id: global.id })).rejects.toThrow("exactly one");
		const deleted = await run({ action: "delete", text: "MIRO", scope: "global" });
		expect(deleted.content[0]?.text).toContain(global.id);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(global.id), "info");
		expect(store.list().map((item) => item.id)).toEqual([project.id]);
		expect((await run({ action: "delete", id: project.id })).content[0]?.text).toContain("Deleted memory");
		expect(new MemoryStore(dir, "/other").list().map((item) => item.id)).toEqual([hidden.id]);
	});

	it("prioritizes projects and bounds JSON bytes and entry count", () => {
		const dir = directory();
		const store = new MemoryStore(dir, "/first");
		const project = store.save("project preference", "project");
		for (let i = 0; i < 45; i++) store.save(`global ${i}`, "global");
		const result = selectMemories(store.list());
		expect(result.selected).toHaveLength(MEMORY_MAX_ENTRIES);
		expect(result.selected[0]?.id).toBe(project.id);
		expect(result.omitted).toHaveLength(6);
		const long = Array.from({ length: 30 }, (_, i) => ({
			...project,
			id: String(i),
			text: '😀"'.repeat(190),
		}));
		const bounded = selectMemories(long);
		expect(bounded.omitted.length).toBeGreaterThan(0);
		expect(
			Buffer.byteLength(JSON.stringify(bounded.selected.map(({ scope, text }) => ({ scope, text })))),
		).toBeLessThanOrEqual(MEMORY_MAX_BYTES);
	});

	it("persists global and project memories independently and supports updating and deleting", () => {
		const dir = directory();
		const first = new MemoryStore(dir, "/first");
		const other = new MemoryStore(dir, "/other");
		const global = first.save("Use concise answers", "global");
		const project = first.save("Use project tests", "project");
		expect(other.list().map((m) => m.id)).toEqual([global.id]);
		expect(() => other.save("wrong project", "project", project.id)).toThrow();
		expect(first.save("Use short answers", "global", global.id).createdAt).toBe(global.createdAt);
		expect(first.delete(global.id, global)).toBe(false);
		expect(first.list().find((m) => m.id === global.id)?.text).toBe("Use short answers");
		expect(other.delete(project.id)).toBe(false);
		expect(first.delete(project.id)).toBe(true);
		expect(new MemoryStore(dir, "/first").list()).toHaveLength(1);
		const lock = join(dir, "memory", `.${global.id}.lock`);
		mkdirSync(lock);
		expect(() => first.delete(global.id)).toThrow("being modified");
		expect(first.list()).toHaveLength(1);
		rmSync(lock, { recursive: true });
		if (process.platform !== "win32")
			expect(statSync(join(dir, "memory", `${global.id}.json`)).mode & 0o777).toBe(0o600);
	});

	it("injects memories only while enabled and private mode is off", async () => {
		const dir = directory();
		process.env.CHALICE_CODING_AGENT_DIR = dir;
		const saved = new MemoryStore(dir, "/first").save("prefers concise answers", "global");
		const entries: { type: string; customType: string; data: unknown }[] = [];
		let context:
			| ((
					event: {
						messages: { role: "system"; content: string | { type: "text"; text: string }[]; timestamp: number }[];
					},
					ctx: ExtensionContext,
			  ) => Promise<{ messages: { content: string | { type: "text"; text: string }[] }[] } | undefined>)
			| undefined;
		let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
		const pi = {
			on: (_name: string, handler: typeof context) => {
				context = handler;
			},
			registerTool: () => {},
			registerCommand: (_name: string, def: { handler: typeof command }) => {
				command = def.handler;
			},
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: "/first",
			isProjectTrusted: () => false,
			sessionManager: { getBranch: () => entries },
			ui: { notify: vi.fn() },
		} as unknown as ExtensionContext;
		memoryExtension(pi);
		if (!context || !command) throw new Error("handlers missing");
		const event = { messages: [{ role: "system" as const, content: "base", timestamp: 0 }] };
		expect((await context(event, ctx))?.messages[0]?.content).toContain("prefers concise answers");
		expect((await context(event, ctx))?.messages[0]?.content).not.toContain(saved.id);
		expect(event.messages[0]?.content).toBe("base");
		const blocks = [{ type: "text" as const, text: "original block" }];
		const blockResult = await context({ messages: [{ role: "system", content: blocks, timestamp: 0 }] }, ctx);
		expect(blockResult?.messages[0]?.content).toEqual([
			blocks[0],
			expect.objectContaining({ text: expect.stringContaining("prefers concise answers") }),
		]);
		expect(blocks).toHaveLength(1);
		for (let i = 0; i < 40; i++) new MemoryStore(dir, "/first").save(`other ${i}`, "global");
		await command("list", ctx);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(saved.id), "info");
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("1 omitted"), "info");
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("[not injected]"), "info");
		await command("private on", ctx);
		expect(await context(event, ctx)).toBeUndefined();
		await command("list", ctx);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("no memories are injected"), "info");
		await command("private off", ctx);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ chaliceMemorySaving: false }));
		expect(await context(event, ctx)).toBeUndefined();
	});
});
