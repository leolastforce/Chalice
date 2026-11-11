import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AcceptanceCoordinator } from "../../../Chalice/PermissionModes/src/acceptance.ts";
import { BlockedPaths, SessionApprovals } from "../../../Chalice/PermissionModes/src/approvals.ts";
import { loadStockDefaults } from "../../../Chalice/PermissionModes/src/config-load.ts";
import { NetworkSession } from "../../../Chalice/PermissionModes/src/network.ts";
import type { SandboxController } from "../../../Chalice/PermissionModes/src/sandbox.ts";

describe("permission tool allocation", () => {
	const root = mkdtempSync(join(tmpdir(), "permission-tools-"));
	const config = loadStockDefaults();
	const select = vi.fn(async () => undefined);
	const ctx = {
		cwd: root,
		hasUI: true,
		ui: { select, notify: vi.fn() },
		sessionManager: { getSessionId: () => "permission-tool-allocation-test" },
	} as unknown as ExtensionContext;
	const blocked = new BlockedPaths();
	let modeName = "plan";
	const anchors = new Map<string, string>();
	const coordinator = new AcceptanceCoordinator(
		root,
		new SessionApprovals(),
		new NetworkSession(),
		{} as SandboxController,
		() => config,
		() => modeName,
		async () => {},
		() => {},
		() => {},
		async (_ctx, first, last) => {
			const target = anchors.get(first);
			if (!target || (last && anchors.get(last) !== target)) throw new Error("Unknown anchor");
			return target;
		},
	);
	async function evaluate(toolName: string, input: Record<string, unknown>) {
		const mode = config.modes[modeName];
		return coordinator.evaluateToolCall(
			{ type: "tool_call", toolName, toolCallId: "test", input } as ToolCallEvent,
			ctx,
			{ mode, effectiveSandbox: mode.sandbox, blocked },
		);
	}
	afterEach(() => {
		select.mockClear();
		modeName = "plan";
		blocked.clear();
	});
	it("allows todos in every stock mode", async () => {
		for (const name of Object.keys(config.modes)) {
			modeName = name;
			expect(await evaluate("todo", { action: "add", text: "test" })).toBeUndefined();
		}
		expect(select).not.toHaveBeenCalled();
	});
	it("allows read-only tools but asks for memory mutations in Plan", async () => {
		for (const [name, input] of [
			["memory", { action: "list" }],
			["codemode", {}],
			["conversation_history", {}],
			["semantic_code_search", {}],
			["list_code_tags", {}],
			["web_fetch", {}],
			["read", { path: "file.ts" }],
			["anchor_grep", {}],
		] as const)
			expect(await evaluate(name, input)).toBeUndefined();
		expect(select).not.toHaveBeenCalled();
		expect(await evaluate("memory", { action: "save" })).toMatchObject({ block: true });
		expect(await evaluate("memory", { action: "delete" })).toMatchObject({ block: true });
		expect(select).toHaveBeenCalledTimes(2);
	});
	it("checks anchor edits against the actual target and fails closed on unknown anchors", async () => {
		const ts = "aaaa";
		const md = "bbbb";
		anchors.set(ts, join(root, "file.ts"));
		anchors.set(md, join(root, "plan.md"));
		for (const [name, input] of [
			["replace", { remove_from: ts, remove_to: ts }],
			["insert", { anchor: ts }],
			["undo_last_change", { path: "file.ts" }],
		] as const)
			expect(await evaluate(name, input)).toMatchObject({
				block: true,
				reason: "Plan allows editing Markdown files only",
			});
		expect(await evaluate("replace", { remove_from: md, remove_to: md })).toBeUndefined();
		expect(await evaluate("insert", { anchor: md })).toBeUndefined();
		expect(await evaluate("undo_last_change", { path: "plan.md" })).toBeUndefined();
		expect(await evaluate("insert", { anchor: "zzzz" })).toMatchObject({ block: true });
	});
	it("rejects protected and externally blocked anchor targets in Build", async () => {
		modeName = "build";
		const protectedAnchor = "cccc";
		anchors.set(protectedAnchor, join(root, ".env"));
		expect(await evaluate("insert", { anchor: protectedAnchor })).toMatchObject({ block: true });
		const external = join(tmpdir(), "permission-blocked-file.ts");
		const anchor = "dddd";
		anchors.set(anchor, external);
		blocked.add(external);
		expect(await evaluate("insert", { anchor })).toMatchObject({ block: true });
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));
});
