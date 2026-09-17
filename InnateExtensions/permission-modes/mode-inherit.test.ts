import { afterEach, describe, expect, it } from "vitest";
import {
	applyInheritedModeForChild,
	PERMISSION_MODES_INHERITED_MODE_ENV,
	publishInheritedPermissionMode,
	resolveInheritedPermissionMode,
} from "./mode-inherit.ts";
import { SUBAGENT_CHILD_ENV } from "./permission-forwarding.ts";

describe("mode-inherit", () => {
	const prevMode = process.env[PERMISSION_MODES_INHERITED_MODE_ENV];
	const prevChild = process.env[SUBAGENT_CHILD_ENV];

	afterEach(() => {
		if (prevMode === undefined)
			delete process.env[PERMISSION_MODES_INHERITED_MODE_ENV];
		else process.env[PERMISSION_MODES_INHERITED_MODE_ENV] = prevMode;
		if (prevChild === undefined) delete process.env[SUBAGENT_CHILD_ENV];
		else process.env[SUBAGENT_CHILD_ENV] = prevChild;
	});

	it("publishInheritedPermissionMode sets env on parent", () => {
		delete process.env[SUBAGENT_CHILD_ENV];
		publishInheritedPermissionMode("bypass");
		expect(process.env[PERMISSION_MODES_INHERITED_MODE_ENV]).toBe("bypass");
		expect(resolveInheritedPermissionMode()).toBe("bypass");
	});

	it("publishInheritedPermissionMode is no-op in child", () => {
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[PERMISSION_MODES_INHERITED_MODE_ENV] = "ask";
		publishInheritedPermissionMode("bypass");
		expect(process.env[PERMISSION_MODES_INHERITED_MODE_ENV]).toBe("ask");
	});

	it("ignores invalid modes", () => {
		delete process.env[SUBAGENT_CHILD_ENV];
		publishInheritedPermissionMode("yolo");
		expect(resolveInheritedPermissionMode()).toBeUndefined();
	});

	it("applyInheritedModeForChild returns mode for any child when env is set", () => {
		delete process.env[SUBAGENT_CHILD_ENV];
		process.env[PERMISSION_MODES_INHERITED_MODE_ENV] = "bypass";
		expect(applyInheritedModeForChild()).toBeUndefined();

		process.env[SUBAGENT_CHILD_ENV] = "1";
		expect(applyInheritedModeForChild({ flagSet: true, currentMode: "ask" })).toBe(
			"bypass",
		);
		expect(applyInheritedModeForChild()).toBe("bypass");
	});
});
