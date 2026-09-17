/**
 * Typed adapter over ctx.sessionManager — the single place that knows pi's
 * real SessionEntry shape. Messages arrive wrapped as
 * {type:"message", message: AgentMessage} with roles user/assistant/toolResult
 * (never "tool"). A private shape guess elsewhere previously left the
 * injection probe dead at runtime (plan B1); every session read goes through
 * this port so the shape has one owner and one test surface.
 */

/** Structural mirror of pi-ai AgentMessage (subset the extension consumes). */
export interface BranchAgentMessage {
	role: "user" | "assistant" | "toolResult"
	content?: unknown
	/** Assistant messages only: cumulative usage for the turn. */
	usage?: {
		input?: number
		output?: number
		cacheRead?: number
		cacheWrite?: number
		cost?: { total?: number }
	}
	/** toolResult messages only. */
	toolName?: string
	toolCallId?: string
}

/** pi SessionMessageEntry (vendored typings 0.80+ shape). */
export interface BranchMessageEntry {
	type: "message"
	id?: string
	message: BranchAgentMessage
}

/** pi CustomEntry subset used for mode-state persistence. */
export interface BranchCustomEntry {
	type: "custom"
	customType?: string
	data?: unknown
}

export type BranchEntry = BranchMessageEntry | BranchCustomEntry | { type: string }

type SessionManagerLike = {
	getBranch?: () => unknown
	getEntries?: () => unknown
	getGitBranch?: () => unknown
	getSessionId?: () => unknown
}

/** Raw wrapped entries from getBranch(), for transcript builders. */
export function readBranchEntries(sessionManager: unknown): BranchEntry[] {
	try {
		const raw = (sessionManager as SessionManagerLike | undefined)?.getBranch?.()
		return Array.isArray(raw) ? (raw as BranchEntry[]) : []
	} catch {
		return []
	}
}

/** Unwrapped agent messages (message entries only), in branch order. */
export function readBranchMessages(
	sessionManager: unknown,
): BranchAgentMessage[] {
	const messages: BranchAgentMessage[] = []
	for (const entry of readBranchEntries(sessionManager)) {
		if (entry?.type !== "message") continue
		const msg = (entry as BranchMessageEntry).message
		if (msg && (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult")) {
			messages.push(msg)
		}
	}
	return messages
}

/** Data payloads of custom entries with the given customType, oldest first. */
export function readCustomEntryData(
	sessionManager: unknown,
	customType: string,
): unknown[] {
	const payloads: unknown[] = []
	try {
		const raw = (sessionManager as SessionManagerLike | undefined)?.getEntries?.()
		if (!Array.isArray(raw)) return payloads
		for (const entry of raw as BranchEntry[]) {
			if (entry?.type !== "custom") continue
			const custom = entry as BranchCustomEntry
			if (custom.customType === customType && custom.data !== undefined) {
				payloads.push(custom.data)
			}
		}
	} catch {
		return payloads
	}
	return payloads
}

/** Current git branch name, or undefined when unavailable. */
export function readGitBranch(sessionManager: unknown): string | undefined {
	try {
		const raw = (sessionManager as SessionManagerLike | undefined)?.getGitBranch?.()
		return typeof raw === "string" ? raw : undefined
	} catch {
		return undefined
	}
}

/** Session id when available (used by permission-request forwarding). */
export function readSessionId(sessionManager: unknown): string | undefined {
	try {
		const raw = (sessionManager as SessionManagerLike | undefined)?.getSessionId?.()
		return typeof raw === "string" ? raw : undefined
	} catch {
		return undefined
	}
}
