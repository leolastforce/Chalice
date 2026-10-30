import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import testMethodsExtension from "../../../Chalice/TestMethods/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";

type Entry = { type: string; customType?: string; data?: unknown };
type Command = (args: string, ctx: ExtensionContext) => Promise<void>;
type BeforeStart = (
	event: { systemPrompt: string },
	ctx: ExtensionContext,
) => Promise<{ systemPrompt: string } | undefined>;

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(entries: Entry[] = []) {
	const cwd = mkdtempSync(join(tmpdir(), "test-methods-"));
	directories.push(cwd);
	writeFileSync(join(cwd, "TESTMETHODS.md"), "Run focused tests.");
	let command: Command | undefined;
	let beforeStart: BeforeStart | undefined;
	const notify = vi.fn();
	const ctx = { cwd, sessionManager: { getBranch: () => entries }, ui: { notify } } as unknown as ExtensionContext;
	const pi = {
		registerCommand: (_name: string, definition: { handler: Command }) => {
			command = definition.handler;
		},
		on: (_name: string, handler: BeforeStart) => {
			beforeStart = handler;
		},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	testMethodsExtension(pi);
	if (!command || !beforeStart) throw new Error("TestMethods handlers were not registered");
	return { command, beforeStart, ctx, notify };
}

describe("TestMethods session state", () => {
	it("defaults to enabled on an empty branch and toggles off", async () => {
		const { beforeStart, command, ctx, notify } = setup();
		expect((await beforeStart({ systemPrompt: "base" }, ctx))?.systemPrompt).toContain("Run focused tests.");
		await command("", ctx);
		expect(notify).toHaveBeenCalledWith("Test-method prompting disabled for this session", "info");
		expect(await beforeStart({ systemPrompt: "base" }, ctx)).toBeUndefined();
	});

	it("ignores unrelated and malformed entries and uses the latest valid toggle", async () => {
		const entries: Entry[] = [
			{ type: "message" },
			{ type: "custom", customType: "other", data: { enabled: false } },
			{ type: "custom", customType: "session-test-methods", data: { enabled: false } },
			{ type: "custom", customType: "session-test-methods", data: { enabled: true } },
			{ type: "custom", customType: "session-test-methods", data: undefined },
			{ type: "custom", customType: "session-test-methods", data: { enabled: "false" } },
		];
		const { beforeStart, command, ctx } = setup(entries);
		expect((await beforeStart({ systemPrompt: "base" }, ctx))?.systemPrompt).toContain("Run focused tests.");
		await command("", ctx);
		expect(await beforeStart({ systemPrompt: "base" }, ctx)).toBeUndefined();
		await command("true", ctx);
		expect((await beforeStart({ systemPrompt: "base" }, ctx))?.systemPrompt).toContain("Run focused tests.");
	});
});
