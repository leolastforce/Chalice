import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import conversationHistoryExtension from "../../../Chalice/ConversationHistory/index.ts";
import { readHistoryReference, searchHistory } from "../../../Chalice/ConversationHistory/search.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";

const previousAgentDir = process.env.CHALICE_CODING_AGENT_DIR;
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.CHALICE_CODING_AGENT_DIR;
	else process.env.CHALICE_CODING_AGENT_DIR = previousAgentDir;
});
function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "chalice-history-"));
	directories.push(dir);
	return dir;
}
function save(root: string, id: string, cwd: string, entries: object[], parentSession?: string): string {
	const dir = join(root, "--project--");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${id}.jsonl`);
	const header = { type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd, parentSession };
	writeFileSync(path, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n"));
	return path;
}
function message(id: string, parentId: string | null, role: string, content: string, index: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2025-01-01T00:00:0${index}.000Z`,
		message: { role, content, timestamp: Date.parse(`2025-01-01T00:00:0${index}.000Z`) },
	};
}
// yo who the FUCK actually reads this I am the only maintainer of this project WHY are you here?

describe("local conversation history search", () => {
	it("searches by default, honors opt-out, and blocks retrieval in private mode", async () => {
		const dir = fixture();
		process.env.CHALICE_CODING_AGENT_DIR = dir;
		const sessionRoot = join(dir, "sessions");
		save(sessionRoot, "old-session", "/project", [
			message("old-user", null, "user", "We chose a parry mechanic for the prototype", 1),
		]);
		const branch: { type: string; customType?: string; data?: unknown }[] = [];
		type Params = {
			action: "search" | "read";
			query?: string;
			scope?: "project" | "all";
			reference?: {
				sessionId: string;
				cwd: string;
				entryIds: string[];
				matchEntryId: string;
				scope: "project" | "all";
				signature: string;
			};
		};
		let execute:
			| ((
					id: string,
					params: Params,
					signal: AbortSignal | undefined,
					update: undefined,
					ctx: ExtensionContext,
			  ) => Promise<{ content: { text: string }[] }>)
			| undefined;
		const pi = {
			registerTool: (tool: { execute: typeof execute }) => {
				execute = tool.execute;
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: "/project",
			isProjectTrusted: () => false,
			hasUI: false,
			sessionManager: {
				getBranch: () => branch,
				getHeader: () => ({ id: "current-session" }),
				getSessionDir: () => join(sessionRoot, "--project--"),
			},
		} as unknown as ExtensionContext;
		conversationHistoryExtension(pi);
		if (!execute) throw new Error("conversation history tool missing");
		const run = (params: Params) => execute!("call", params, undefined, undefined, ctx);
		const results = await run({ action: "search", query: "prototype parry" });
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ chaliceConversationSearch: false }));
		expect((await run({ action: "search", query: "prototype parry" })).content[0]?.text).toContain("disabled");
		expect(results.content[0]?.text).toContain("old-session");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ chaliceConversationSearch: true }));
		branch.push({ type: "custom", customType: "chalice-memory-private", data: true });
		expect((await run({ action: "search", query: "prototype parry" })).content[0]?.text).toContain("private mode");
	});

	it("returns more than ten results when requested within the response budget", async () => {
		const root = fixture();
		for (let i = 0; i < 20; i++) {
			save(root, `session-${i}`, "/project", [message(`u${i}`, null, "user", `matching detail ${i}`, 1)]);
		}
		const found = JSON.parse(
			await searchHistory({ roots: [root], cwd: "/project", query: "matching", limit: 50 }),
		) as { hits: unknown[] };
		expect(found.hits).toHaveLength(20);
	});

	it("ranks local excerpts, returns a readable reference, and never rewrites session files", async () => {
		const root = fixture();
		const path = save(root, "session-one", "/project", [
			message("u1", null, "user", "We discussed the prototype's stagger mechanic.", 1),
			message("a1", "u1", "assistant", "The stagger mechanic should reward poise breaks.", 2),
		]);
		const before = statSync(path);
		const bytes = readFileSync(path);
		const found = JSON.parse(await searchHistory({ roots: [root], cwd: "/project", query: "stagger mechanic" })) as {
			complete: boolean;
			hits: {
				reference: {
					sessionId: string;
					cwd: string;
					entryIds: string[];
					matchEntryId: string;
					scope: "project" | "all";
					signature: string;
				};
			}[];
		};
		expect(found.complete).toBe(true);
		expect(found.hits).toHaveLength(1);
		expect(found.hits[0]?.reference.sessionId).toBe("session-one");
		const excerpt = JSON.parse(
			await readHistoryReference({ roots: [root], cwd: "/project", reference: found.hits[0]!.reference }),
		) as { messages: { text: string }[] };
		expect(excerpt.messages.map((item) => item.text).join(" ")).toContain("stagger mechanic");
		expect(readFileSync(path)).toEqual(bytes);
		expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
	});

	it("supports legacy transcripts, quoted phrases, and message-date filters without modifying source", async () => {
		const root = fixture();
		const path = save(root, "legacy", "/project", [
			message("old-user", null, "user", "The generous parry window felt fair", 1),
		]);
		writeFileSync(path, readFileSync(path, "utf8").replace('"version":3,', ""));
		const bytes = readFileSync(path);
		const found = JSON.parse(await searchHistory({ roots: [root], cwd: "/project", query: '"generous parry"' })) as {
			hits: { reference: { matchEntryId: string } }[];
		};
		expect(found.hits).toHaveLength(1);
		expect(found.hits[0]?.reference.matchEntryId).toBe("legacy-0");
		const after = JSON.parse(
			await searchHistory({
				roots: [root],
				cwd: "/project",
				query: '"generous parry"',
				after: "2025-01-01T00:00:02.000Z",
			}),
		) as { hits: unknown[] };
		expect(after.hits).toHaveLength(0);
		expect(readFileSync(path)).toEqual(bytes);
	});

	it("enforces project scope, excludes private, forked, and active sessions, and honors context edits", async () => {
		const root = fixture();
		const ordinary = [
			message("u1", null, "user", "Question about the prototype boss", 1),
			message("a1", "u1", "assistant", "We decided its parry timing is forgiving", 2),
		];
		save(root, "same", "/project", ordinary);
		save(root, "other", "/other", [message("x1", null, "user", "Prototype boss elsewhere", 1)]);
		save(root, "private", "/project", [
			...ordinary,
			{ type: "custom", id: "p1", parentId: "a1", customType: "chalice-memory-private", data: true },
		]);
		save(root, "fork", "/project", ordinary, "/source/session.jsonl");
		save(root, "edited", "/project", [
			message("e1", null, "user", "Prototype boss hidden original", 1),
			{ type: "context_edit", id: "edit1", parentId: "e1", targetId: "e1", replacement: null },
		]);
		const local = JSON.parse(
			await searchHistory({ roots: [root], cwd: "/project", query: "prototype boss", currentSessionId: "same" }),
		) as { hits: unknown[] };
		expect(local.hits).toHaveLength(0);
		const all = JSON.parse(
			await searchHistory({ roots: [root], cwd: "/project", query: "prototype boss", scope: "all" }),
		) as { hits: { session: string }[] };
		expect(all.hits.map((hit) => hit.session)).toContain("other");
		expect(all.hits.map((hit) => hit.session)).not.toContain("private");
		expect(all.hits.map((hit) => hit.session)).not.toContain("fork");
		expect(all.hits.map((hit) => hit.session)).not.toContain("edited");
	});

	it("returns stale/deleted references as unavailable and bounds result size", async () => {
		const root = fixture();
		const long = `specific detail ${"word ".repeat(10_000)}`;
		const path = save(root, "large", "/project", [message("u1", null, "user", long, 1)]);
		const found = JSON.parse(await searchHistory({ roots: [root], cwd: "/project", query: "specific detail" })) as {
			truncated: boolean;
			hits: {
				reference: {
					sessionId: string;
					cwd: string;
					entryIds: string[];
					matchEntryId: string;
					scope: "project" | "all";
					signature: string;
				};
			}[];
		};
		expect(found.truncated).toBe(true);
		const reference = found.hits[0]!.reference;
		const excerpt = await readHistoryReference({ roots: [root], cwd: "/project", reference });
		expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(16_000);
		expect(excerpt).toContain("clipped");
		writeFileSync(path, readFileSync(path, "utf8").replace("specific detail", "changed detail"));
		expect(await readHistoryReference({ roots: [root], cwd: "/project", reference })).toContain(
			"changed since search",
		);
		rmSync(path);
		expect(await readHistoryReference({ roots: [root], cwd: "/project", reference })).toContain("unavailable");
	});
});
