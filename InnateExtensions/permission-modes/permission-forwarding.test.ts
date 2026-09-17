import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createForwardingPoller,
	isValidForwardedResponse,
	listPendingRequests,
	pollForwardedResponse,
	resolveParentSessionId,
	setAgentDirForTests,
	SUBAGENT_PARENT_SESSION_ENV,
	writeForwardedRequest,
	writeForwardedResponse,
	type ForwardedPermissionRequest,
} from "./permission-forwarding.ts";

describe("permission-forwarding", () => {
	let agentDir: string;
	const prevParent = process.env[SUBAGENT_PARENT_SESSION_ENV];
	const prevChild = process.env.PI_SUBAGENT_CHILD;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pm-fwd-"));
		setAgentDirForTests(agentDir);
		delete process.env[SUBAGENT_PARENT_SESSION_ENV];
		delete process.env.PI_SUBAGENT_CHILD;
	});

	afterEach(() => {
		setAgentDirForTests(undefined);
		rmSync(agentDir, { recursive: true, force: true });
		if (prevParent === undefined) delete process.env[SUBAGENT_PARENT_SESSION_ENV];
		else process.env[SUBAGENT_PARENT_SESSION_ENV] = prevParent;
		if (prevChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = prevChild;
	});

	it("resolveParentSessionId is undefined without env", () => {
		expect(resolveParentSessionId()).toBeUndefined();
	});

	it("resolveParentSessionId trims and ignores empty", () => {
		process.env[SUBAGENT_PARENT_SESSION_ENV] = "  ";
		expect(resolveParentSessionId()).toBeUndefined();
		process.env[SUBAGENT_PARENT_SESSION_ENV] = "  parent-abc  ";
		expect(resolveParentSessionId()).toBe("parent-abc");
	});

	it("write → list → response → poll approved true", async () => {
		const { id, challenge } = await writeForwardedRequest({
			agentDir,
			targetSessionId: "parent-1",
			requesterSessionId: "child-1",
			tool: "bash",
			label: "run gh",
			category: "user-prompt",
			cwd: "/tmp/proj",
			input: { command: "gh pr view" },
		});
		const pending = await listPendingRequests(agentDir, "parent-1");
		expect(pending).toHaveLength(1);
		expect(pending[0].id).toBe(id);
		expect(pending[0].challenge).toBe(challenge);
		expect(pending[0].tool).toBe("bash");

		await writeForwardedResponse(agentDir, "parent-1", {
			id,
			challenge,
			approved: true,
			decision: "allow",
			responderSessionId: "parent-1",
			respondedAt: new Date().toISOString(),
		});

		const resp = await pollForwardedResponse(agentDir, "parent-1", id, {
			challenge,
			timeoutMs: 2000,
			pollIntervalMs: 20,
		});
		expect(resp?.approved).toBe(true);
		expect(resp?.decision).toBe("allow");
		expect(await listPendingRequests(agentDir, "parent-1")).toHaveLength(0);
	});

	it("poll returns null on short timeout without response", async () => {
		const { id, challenge } = await writeForwardedRequest({
			agentDir,
			targetSessionId: "parent-2",
			tool: "read",
			label: "outside",
			category: "user-prompt",
			cwd: "/tmp",
			input: { path: "/etc/hosts" },
		});
		const resp = await pollForwardedResponse(agentDir, "parent-2", id, {
			challenge,
			timeoutMs: 80,
			pollIntervalMs: 20,
		});
		expect(resp).toBeNull();
	});

	it("block decision yields approved false", async () => {
		const { id, challenge } = await writeForwardedRequest({
			agentDir,
			targetSessionId: "parent-3",
			tool: "bash",
			label: "rm -rf",
			category: "user-prompt",
			cwd: "/tmp",
			input: { command: "rm -rf /" },
		});
		await writeForwardedResponse(agentDir, "parent-3", {
			id,
			challenge,
			approved: false,
			decision: "block",
			responderSessionId: "parent-3",
			respondedAt: new Date().toISOString(),
			denialReason: "bash blocked by user",
		});
		const resp = await pollForwardedResponse(agentDir, "parent-3", id, {
			challenge,
			timeoutMs: 2000,
			pollIntervalMs: 20,
		});
		expect(resp?.approved).toBe(false);
		expect(resp?.decision).toBe("block");
		expect(resp?.denialReason).toContain("blocked");
	});

	it("rejects forged response without matching challenge", async () => {
		const { id, challenge } = await writeForwardedRequest({
			agentDir,
			targetSessionId: "parent-forge",
			tool: "bash",
			label: "x",
			category: "user-prompt",
			cwd: "/tmp",
			input: {},
		});
		await writeForwardedResponse(agentDir, "parent-forge", {
			id,
			challenge: "00000000-0000-0000-0000-000000000000",
			approved: true,
			decision: "allow",
			responderSessionId: "parent-forge",
			respondedAt: new Date().toISOString(),
		});
		const pollPromise = pollForwardedResponse(agentDir, "parent-forge", id, {
			challenge,
			timeoutMs: 150,
			pollIntervalMs: 20,
		});
		// Later legitimate response after forged one was discarded
		setTimeout(() => {
			void writeForwardedResponse(agentDir, "parent-forge", {
				id,
				challenge,
				approved: true,
				decision: "allow",
				responderSessionId: "parent-forge",
				respondedAt: new Date().toISOString(),
			});
		}, 40);
		const resp = await pollPromise;
		expect(resp?.approved).toBe(true);
		expect(resp?.challenge).toBe(challenge);
	});

	it("invalid json response does not end poll early", async () => {
		const { id, challenge } = await writeForwardedRequest({
			agentDir,
			targetSessionId: "parent-bad",
			tool: "bash",
			label: "x",
			category: "user-prompt",
			cwd: "/tmp",
			input: {},
		});
		const respPath = join(
			agentDir,
			"sessions",
			"permission-modes-forwarding",
			"sessions",
			encodeURIComponent("parent-bad"),
			"responses",
			`${id}.json`,
		);
		mkdirSync(join(respPath, ".."), { recursive: true });
		writeFileSync(respPath, "{not-json");

		const pollPromise = pollForwardedResponse(agentDir, "parent-bad", id, {
			challenge,
			timeoutMs: 300,
			pollIntervalMs: 20,
		});
		setTimeout(() => {
			void writeForwardedResponse(agentDir, "parent-bad", {
				id,
				challenge,
				approved: false,
				decision: "block",
				responderSessionId: "parent-bad",
				respondedAt: new Date().toISOString(),
				denialReason: "blocked",
			});
		}, 50);
		const resp = await pollPromise;
		expect(resp?.approved).toBe(false);
		expect(resp?.decision).toBe("block");
	});

	it("isValidForwardedResponse rejects approved/decision mismatch", () => {
		expect(
			isValidForwardedResponse(
				{
					id: "a",
					challenge: "1234567890abcdef",
					approved: true,
					decision: "block",
					responderSessionId: "p",
					respondedAt: new Date().toISOString(),
				},
				{ id: "a", challenge: "1234567890abcdef", targetSessionId: "p" },
			),
		).toBe(false);
	});

	it("poller start is no-op when isChild", async () => {
		const onRequest = vi.fn();
		const poller = createForwardingPoller({
			agentDir,
			getSessionId: () => "parent-4",
			hasUI: true,
			isChild: true,
			onRequest,
			pollIntervalMs: 30,
		});
		poller.start();
		await writeForwardedRequest({
			agentDir,
			targetSessionId: "parent-4",
			tool: "bash",
			label: "x",
			category: "user-prompt",
			cwd: "/tmp",
			input: {},
		});
		await new Promise((r) => setTimeout(r, 100));
		expect(onRequest).not.toHaveBeenCalled();
		poller.stop();
	});

	it("poller start is no-op when !hasUI", async () => {
		const onRequest = vi.fn();
		const poller = createForwardingPoller({
			agentDir,
			getSessionId: () => "parent-5",
			hasUI: false,
			isChild: false,
			onRequest,
			pollIntervalMs: 30,
		});
		poller.start();
		await writeForwardedRequest({
			agentDir,
			targetSessionId: "parent-5",
			tool: "bash",
			label: "x",
			category: "user-prompt",
			cwd: "/tmp",
			input: {},
		});
		await new Promise((r) => setTimeout(r, 100));
		expect(onRequest).not.toHaveBeenCalled();
		poller.stop();
	});

	it("poller invokes onRequest then inbox clears", async () => {
		const handled: ForwardedPermissionRequest[] = [];
		const poller = createForwardingPoller({
			agentDir,
			getSessionId: () => "parent-6",
			hasUI: true,
			isChild: false,
			pollIntervalMs: 30,
			onRequest: async (req) => {
				handled.push(req);
				await writeForwardedResponse(agentDir, "parent-6", {
					id: req.id,
					challenge: req.challenge,
					approved: true,
					decision: "allow",
					responderSessionId: "parent-6",
					respondedAt: new Date().toISOString(),
				});
			},
		});
		poller.start();
		const { id } = await writeForwardedRequest({
			agentDir,
			targetSessionId: "parent-6",
			tool: "grep",
			label: "search",
			category: "permission-ask",
			cwd: "/work",
			input: { pattern: "foo" },
		});
		await vi.waitFor(
			() => {
				expect(handled.some((r) => r.id === id)).toBe(true);
			},
			{ timeout: 2000, interval: 20 },
		);
		expect(await listPendingRequests(agentDir, "parent-6")).toHaveLength(0);
		poller.stop();
	});

	it("shared claimedIds prevents double onRequest across poller restart", async () => {
		const calls: string[] = [];
		const claimedIds = new Set<string>();
		const onRequest = async (req: ForwardedPermissionRequest) => {
			calls.push(req.id);
			await new Promise((r) => setTimeout(r, 80));
			await writeForwardedResponse(agentDir, "parent-claim", {
				id: req.id,
				challenge: req.challenge,
				approved: true,
				decision: "allow",
				responderSessionId: "parent-claim",
				respondedAt: new Date().toISOString(),
			});
		};
		const p1 = createForwardingPoller({
			agentDir,
			getSessionId: () => "parent-claim",
			hasUI: true,
			isChild: false,
			claimedIds,
			onRequest,
			pollIntervalMs: 20,
		});
		p1.start();
		const { id } = await writeForwardedRequest({
			agentDir,
			targetSessionId: "parent-claim",
			tool: "bash",
			label: "x",
			category: "user-prompt",
			cwd: "/tmp",
			input: {},
		});
		await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), {
			timeout: 1000,
			interval: 10,
		});
		p1.stop();
		const p2 = createForwardingPoller({
			agentDir,
			getSessionId: () => "parent-claim",
			hasUI: true,
			isChild: false,
			claimedIds,
			onRequest,
			pollIntervalMs: 20,
		});
		p2.start();
		await new Promise((r) => setTimeout(r, 100));
		expect(calls.filter((c) => c === id)).toHaveLength(1);
		p2.stop();
	});

	it("ignores requests whose targetSessionId does not match folder", async () => {
		const dir = join(
			agentDir,
			"sessions",
			"permission-modes-forwarding",
			"sessions",
			encodeURIComponent("parent-7"),
			"requests",
		);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "bad.json"),
			JSON.stringify({
				id: "bad",
				challenge: "1234567890abcdef",
				createdAt: new Date().toISOString(),
				requesterSessionId: "",
				targetSessionId: "other-session",
				tool: "bash",
				label: "x",
				category: "user-prompt",
				cwd: "/tmp",
				input: {},
				message: "x",
			}),
		);
		expect(await listPendingRequests(agentDir, "parent-7")).toHaveLength(0);
	});
});
