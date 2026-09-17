import { describe, expect, it } from "vitest"

import {
	accumulateBranchStats,
	emptyBranchStatsState,
	type BranchStatsState,
} from "./branch-stats.ts"

type Entry = {
	type: string
	id?: string
	message?: {
		role: string
		usage?: {
			input?: number
			output?: number
			cacheRead?: number
			cacheWrite?: number
			cost?: { total?: number }
		}
	}
}

/** Reference implementation: brute-force sum in branch order. */
function bruteForce(branch: Entry[]): BranchStatsState["accum"] {
	const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
	for (const e of branch) {
		if (e?.type !== "message") continue
		const u = e.message?.usage
		if (!u) continue
		acc.input += u.input || 0
		acc.output += u.output || 0
		acc.cacheRead += u.cacheRead || 0
		acc.cacheWrite += u.cacheWrite || 0
		acc.cost += u.cost?.total || 0
	}
	return acc
}

/** Deterministic PRNG (mulberry32) so failures reproduce from the seed. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

let idCounter = 0
function randomEntry(rnd: () => number): Entry {
	const kind = rnd()
	idCounter++
	if (kind < 0.55) {
		// assistant with random usage (floats included for cost exactness)
		return {
			type: "message",
			id: `e${idCounter}`,
			message: {
				role: "assistant",
				usage: {
					input: Math.floor(rnd() * 5000),
					output: Math.floor(rnd() * 2000),
					cacheRead: Math.floor(rnd() * 50000),
					cacheWrite: Math.floor(rnd() * 8000),
					cost: { total: Number((rnd() * 0.5).toFixed(6)) },
				},
			},
		}
	}
	if (kind < 0.75) {
		return { type: "message", id: `e${idCounter}`, message: { role: "user", content: "hi" } }
	}
	if (kind < 0.9) {
		return {
			type: "message",
			id: `e${idCounter}`,
			message: { role: "toolResult", toolName: "bash", content: [] },
		}
	}
	if (kind < 0.97) {
		return { type: "custom", id: `e${idCounter}`, customType: "modes", data: {} }
	}
	// occasional id-less entry (defensive shape)
	return { type: "message", message: { role: "assistant" } }
}

describe("accumulateBranchStats property: incremental === brute force", () => {
	it("matches exactly across randomized append/fork/switch sequences", () => {
		for (let seed = 1; seed <= 200; seed++) {
			const rnd = mulberry32(seed)
			const state = emptyBranchStatsState()
			let branch: Entry[] = []

			const steps = 3 + Math.floor(rnd() * 12)
			for (let step = 0; step < steps; step++) {
				const op = rnd()
				if (op < 0.6) {
					// append-only growth (message_end / toolResult boundaries)
					const n = 1 + Math.floor(rnd() * 3)
					for (let i = 0; i < n; i++) branch.push(randomEntry(rnd))
				} else if (op < 0.75) {
					// fork: keep a random prefix, then extend with fresh entries
					const k = Math.floor(rnd() * (branch.length + 1))
					branch = branch.slice(0, k)
					for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) {
						branch.push(randomEntry(rnd))
					}
				} else if (op < 0.9) {
					// navigate back to a strictly shorter prefix (no new entries)
					if (branch.length > 0) {
						branch = branch.slice(0, Math.floor(rnd() * branch.length))
					}
				} else {
					// switchSession: brand-new branch from scratch
					branch = []
					for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) {
						branch.push(randomEntry(rnd))
					}
				}

				const incremental = accumulateBranchStats(branch, state)
				const reference = bruteForce(branch)
				try {
					expect(incremental).toEqual(reference)
				} catch (err) {
					throw new Error(
						`seed=${seed} step=${step} op=${op.toFixed(2)} branchLen=${branch.length}: ${String(err)}`,
					)
				}
			}
		}
	})

	it("repeated calls on a frozen branch are O(new) and stable", () => {
		const state = emptyBranchStatsState()
		const branch: Entry[] = [
			{
				type: "message",
				id: "a1",
				message: { role: "assistant", usage: { input: 10, output: 5, cost: { total: 0.01 } } },
			},
		]
		const first = accumulateBranchStats(branch, state)
		const again = accumulateBranchStats(branch, state)
		const frozen = accumulateBranchStats(branch, state)
		expect(first).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 })
		expect(again).toEqual(first)
		expect(frozen).toEqual(first)
		expect(state.processedCount).toBe(1)
	})

	it("recomputes when the prefix moves even at the same length", () => {
		const state = emptyBranchStatsState()
		const b1: Entry[] = [
			{ type: "message", id: "x1", message: { role: "user", content: "1" } },
			{ type: "message", id: "x2", message: { role: "assistant", usage: { output: 7 } } },
		]
		expect(accumulateBranchStats(b1, state).output).toBe(7)
		// Same length, different tail id (fork sibling): must not trust prefix.
		const b2: Entry[] = [
			{ type: "message", id: "x1", message: { role: "user", content: "1" } },
			{ type: "message", id: "y9", message: { role: "assistant", usage: { output: 3 } } },
		]
		expect(accumulateBranchStats(b2, state).output).toBe(3)
		// Shorter branch (navigate back): full recompute.
		const b3: Entry[] = [
			{ type: "message", id: "x1", message: { role: "user", content: "1" } },
		]
		expect(accumulateBranchStats(b3, state).output).toBe(0)
	})
})
