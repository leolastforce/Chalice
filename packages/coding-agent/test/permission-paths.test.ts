import { describe, expect, it } from "vitest";
import { isProtectedPath, isProtectedWrite } from "../../../Chalice/PermissionModes/src/paths.ts";

describe("protected Claude paths", () => {
	it("protects the .claude path itself to prevent file/directory collisions", () => {
		expect(isProtectedPath(".claude")).toBe(true);
		expect(isProtectedWrite("/workspace/project", ".claude")).toBe(true);
		expect(isProtectedWrite("/workspace/project", ".claude/")).toBe(true);
	});

	it("continues protecting Claude command and agent directories", () => {
		expect(isProtectedPath(".claude/commands/example.md")).toBe(true);
		expect(isProtectedPath(".claude/agents/reviewer.md")).toBe(true);
	});
});
