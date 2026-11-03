import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AcceptanceCoordinator } from "../../../Chalice/PermissionModes/src/acceptance.ts";
import { SessionApprovals } from "../../../Chalice/PermissionModes/src/approvals.ts";
import { FALLBACK_CONFIG } from "../../../Chalice/PermissionModes/src/config-load.ts";
import { NetworkSession } from "../../../Chalice/PermissionModes/src/network.ts";
import type { SandboxController } from "../../../Chalice/PermissionModes/src/sandbox.ts";

describe("plan approval options", () => {
	it.each(["build", "ask", "yolo"])("approves and switches to %s", async (mode) => {
		const setMode = vi.fn(async () => {});
		const sendFollowUp = vi.fn();
		const appendEntry = vi.fn();
		const select = vi.fn(async (_title: string, options: string[]) =>
			options.find((option) => option.includes(`switch to ${FALLBACK_CONFIG.modes[mode].label} `)),
		);
		const ctx = { hasUI: true, ui: { select, notify: vi.fn() } } as unknown as ExtensionContext;
		const coordinator = new AcceptanceCoordinator(
			".", new SessionApprovals(), new NetworkSession(), {} as SandboxController,
			() => FALLBACK_CONFIG, () => "plan", setMode, sendFollowUp, appendEntry,
		);
		coordinator.setPendingPlan({ path: "plan/example.md", declined: false });

		await coordinator.offerPlanApproval(ctx, FALLBACK_CONFIG.modes.plan);

		expect(select.mock.calls[0][1]).toEqual([
			"Accept: switch to Build and implement it",
			"Accept: switch to Ask and implement it",
			"Accept: switch to YOLO and implement it",
			"Decline: keep refining in Plan",
		]);
		expect(setMode).toHaveBeenCalledWith(mode, ctx);
		expect(sendFollowUp).toHaveBeenCalledWith("The plan in `plan/example.md` is approved. Implement it now.");
		expect(coordinator.currentPendingPlan).toBeUndefined();
	});
});
