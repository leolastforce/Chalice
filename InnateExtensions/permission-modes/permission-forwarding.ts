/**
 * Subagent → parent-session permission ask forwarding (filesystem inbox).
 *
 * Namespace (isolated from gotgenes):
 *   ~/.pi/agent/sessions/permission-modes-forwarding/sessions/<sessionId>/{requests,responses}/
 *
 * Child keeps `challenge` only in memory and requires it echoed on the response,
 * so a forged response that did not read the matching request cannot approve.
 */

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PERMISSION_FORWARDING_POLL_INTERVAL_MS = 250;
export const PERMISSION_FORWARDING_TIMEOUT_MS = 600_000;

export const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

export type ForwardedDecision =
	| "allow"
	| "allow_always_local"
	| "allow_always_global"
	| "block";

export interface ForwardedPermissionRequest {
	id: string;
	/** Secret echoed by parent; child validates against in-memory value. */
	challenge: string;
	createdAt: string;
	requesterSessionId: string;
	targetSessionId: string;
	requesterAgentName?: string;
	tool: string;
	label: string;
	category: string;
	cwd: string;
	input: Record<string, unknown>;
	message: string;
}

export interface ForwardedPermissionResponse {
	id: string;
	challenge: string;
	approved: boolean;
	decision: ForwardedDecision;
	responderSessionId: string;
	respondedAt: string;
	denialReason?: string;
}

let agentDirOverrideForTests: string | undefined;

/** Test-only: redirect forwarding root under a temp agent dir. */
export function setAgentDirForTests(dir: string | undefined): void {
	agentDirOverrideForTests = dir;
}

export function defaultAgentDir(): string {
	return agentDirOverrideForTests ?? join(homedir(), ".pi", "agent");
}

export function resolveParentSessionId(): string | undefined {
	const raw = process.env[SUBAGENT_PARENT_SESSION_ENV]?.trim();
	return raw || undefined;
}

export function isSubagentChildProcess(): boolean {
	return process.env[SUBAGENT_CHILD_ENV] === "1";
}

export function forwardingSessionDir(
	agentDir: string,
	sessionId: string,
): string {
	return join(
		agentDir,
		"sessions",
		"permission-modes-forwarding",
		"sessions",
		encodeURIComponent(sessionId),
	);
}

function requestsDir(agentDir: string, sessionId: string): string {
	return join(forwardingSessionDir(agentDir, sessionId), "requests");
}

function responsesDir(agentDir: string, sessionId: string): string {
	return join(forwardingSessionDir(agentDir, sessionId), "responses");
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
	try {
		chmodSync(dir, 0o700);
	} catch {
		/* ignore */
	}
}

function atomicWriteJson(filePath: string, data: unknown): void {
	const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(tmp, filePath);
}

function readJsonFile<T>(filePath: string): T | null {
	try {
		const raw = readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const DECISIONS: ReadonlySet<string> = new Set([
	"allow",
	"allow_always_local",
	"allow_always_global",
	"block",
]);

/**
 * Validate a response against the expected id/challenge/parent session.
 * Rejects forged or inconsistent payloads (fail-closed).
 */
export function isValidForwardedResponse(
	resp: ForwardedPermissionResponse | null | undefined,
	expected: {
		id: string;
		challenge: string;
		targetSessionId: string;
	},
): resp is ForwardedPermissionResponse {
	if (!resp) return false;
	if (resp.id !== expected.id) return false;
	if (typeof resp.challenge !== "string" || resp.challenge.length < 16)
		return false;
	if (resp.challenge !== expected.challenge) return false;
	if (!DECISIONS.has(resp.decision)) return false;
	if (resp.responderSessionId !== expected.targetSessionId) return false;
	const allowDecisions =
		resp.decision === "allow" ||
		resp.decision === "allow_always_local" ||
		resp.decision === "allow_always_global";
	if (allowDecisions && resp.approved !== true) return false;
	if (resp.decision === "block" && resp.approved !== false) return false;
	return true;
}

export interface WriteForwardedRequestInput {
	agentDir?: string;
	targetSessionId: string;
	requesterSessionId?: string;
	requesterAgentName?: string;
	tool: string;
	label: string;
	category: string;
	cwd: string;
	input: Record<string, unknown>;
	message?: string;
}

export async function writeForwardedRequest(
	input: WriteForwardedRequestInput,
): Promise<{ id: string; challenge: string }> {
	const agentDir = input.agentDir ?? defaultAgentDir();
	const id = randomUUID();
	const challenge = randomUUID();
	const message =
		input.message ?? `Allow ${input.tool}? ${input.label}`;
	const req: ForwardedPermissionRequest = {
		id,
		challenge,
		createdAt: new Date().toISOString(),
		requesterSessionId: input.requesterSessionId ?? "",
		targetSessionId: input.targetSessionId,
		...(input.requesterAgentName
			? { requesterAgentName: input.requesterAgentName }
			: {}),
		tool: input.tool,
		label: input.label,
		category: input.category,
		cwd: input.cwd,
		input: input.input,
		message,
	};
	const dir = requestsDir(agentDir, input.targetSessionId);
	ensureDir(dir);
	ensureDir(responsesDir(agentDir, input.targetSessionId));
	atomicWriteJson(join(dir, `${id}.json`), req);
	return { id, challenge };
}

export async function pollForwardedResponse(
	agentDir: string,
	targetSessionId: string,
	id: string,
	opts: {
		challenge: string;
		timeoutMs?: number;
		pollIntervalMs?: number;
	},
): Promise<ForwardedPermissionResponse | null> {
	const timeoutMs = opts.timeoutMs ?? PERMISSION_FORWARDING_TIMEOUT_MS;
	const pollIntervalMs =
		opts.pollIntervalMs ?? PERMISSION_FORWARDING_POLL_INTERVAL_MS;
	const path = join(responsesDir(agentDir, targetSessionId), `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const resp = readJsonFile<ForwardedPermissionResponse>(path);
			if (
				isValidForwardedResponse(resp, {
					id,
					challenge: opts.challenge,
					targetSessionId,
				})
			) {
				try {
					unlinkSync(path);
				} catch {
					/* ignore */
				}
				return resp;
			}
			// Corrupt / forged / partial write: remove and keep waiting for a
			// legitimate parent response until timeout (fail-closed).
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
		}
		await sleep(pollIntervalMs);
	}
	return null;
}

export async function listPendingRequests(
	agentDir: string,
	sessionId: string,
): Promise<ForwardedPermissionRequest[]> {
	const dir = requestsDir(agentDir, sessionId);
	if (!existsSync(dir)) return [];
	const out: ForwardedPermissionRequest[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const req = readJsonFile<ForwardedPermissionRequest>(join(dir, name));
		if (!req || req.targetSessionId !== sessionId) continue;
		if (typeof req.challenge !== "string" || !req.challenge) continue;
		out.push(req);
	}
	out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return out;
}

export async function writeForwardedResponse(
	agentDir: string,
	targetSessionId: string,
	response: ForwardedPermissionResponse,
): Promise<void> {
	const respDir = responsesDir(agentDir, targetSessionId);
	ensureDir(respDir);
	atomicWriteJson(join(respDir, `${response.id}.json`), response);
	const reqPath = join(
		requestsDir(agentDir, targetSessionId),
		`${response.id}.json`,
	);
	try {
		unlinkSync(reqPath);
	} catch {
		/* ignore */
	}
}

export interface ForwardingPollerOptions {
	agentDir: string;
	getSessionId: () => string | undefined;
	hasUI: boolean;
	isChild: boolean;
	onRequest: (request: ForwardedPermissionRequest) => Promise<void>;
	pollIntervalMs?: number;
	/** Shared across poller restarts so the same request is not handled twice. */
	claimedIds?: Set<string>;
}

export interface ForwardingPoller {
	start(): void;
	stop(): void;
}

export function createForwardingPoller(
	opts: ForwardingPollerOptions,
): ForwardingPoller {
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	const claimed = opts.claimedIds ?? new Set<string>();
	const pollIntervalMs =
		opts.pollIntervalMs ?? PERMISSION_FORWARDING_POLL_INTERVAL_MS;

	async function tick(): Promise<void> {
		if (processing) return;
		const sessionId = opts.getSessionId()?.trim();
		if (!sessionId) return;
		processing = true;
		try {
			const pending = await listPendingRequests(opts.agentDir, sessionId);
			for (const req of pending) {
				if (claimed.has(req.id)) continue;
				claimed.add(req.id);
				try {
					await opts.onRequest(req);
				} catch {
					// Allow retry on hard failure after parent cancel / crash mid-handle.
					claimed.delete(req.id);
					throw new Error("forwarding onRequest failed");
				}
			}
		} catch {
			/* swallow — next tick retries */
		} finally {
			processing = false;
		}
	}

	return {
		start() {
			if (opts.isChild || !opts.hasUI) return;
			if (timer) return;
			timer = setInterval(() => {
				void tick();
			}, pollIntervalMs);
			if (typeof timer === "object" && "unref" in timer) {
				(timer as NodeJS.Timeout).unref();
			}
		},
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
		},
	};
}
