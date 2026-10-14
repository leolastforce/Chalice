import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropicMessages } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import {
	clearInvalidatedReasoningState,
	extractAnthropicThinkingSignatureErrorDetails,
	extractInvalidEncryptedContentItemId,
	isAnthropicThinkingSignatureError,
	isConversationCompacted,
	isInvalidEncryptedContentError,
} from "../src/api/reasoning-sanitization.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model, TextContent, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-6",
	name: "Claude 3.7 Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const openaiModel: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function createAnthropicSuccessResponse(text = "Recovered successfully"): Response {
	const sseEvents = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-6",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			},
		})}\n\n`,
		`event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})}\n\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		})}\n\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({
			type: "content_block_stop",
			index: 0,
		})}\n\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 5 },
		})}\n\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
	];

	return new Response(sseEvents.join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createOpenAISuccessResponse(): Response {
	const event = {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Provider-aware conversation history sanitization regression suite", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		clearInvalidatedReasoningState();
	});

	it("1. recovers Anthropic signed thinking blocks after prefix truncation and records diagnostic", async () => {
		const bodies: unknown[] = [];
		const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
			if (typeof init?.body === "string") {
				bodies.push(JSON.parse(init.body));
			}
			if (bodies.length === 1) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message:
								'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". Content that preceded this block when it was created is missing from this request, starting at `messages.0.content.0`.',
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return createAnthropicSuccessResponse();
		});

		// History with truncated prefix: assistant has a thinking signature created under earlier missing turns
		const context: TranscriptContext = normalizeContext({
			messages: [
				{ role: "user", content: "truncated follow-up prompt", timestamp: 10 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "prior reasoning", thinkingSignature: "sig-truncated-prefix-1" },
						{ type: "text", text: "prior answer" },
					],
					api: anthropicModel.api,
					provider: anthropicModel.provider,
					model: anthropicModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 11,
				},
				{ role: "user", content: "new query", timestamp: 12 },
			],
		});

		const result = await streamAnthropicMessages(anthropicModel, context, {
			apiKey: "test-key",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		// Verify structured diagnostic recorded
		const recoveryDiag = result.diagnostics?.find((d) => d.type === "reasoning_recovery");
		expect(recoveryDiag).toBeDefined();
		expect(recoveryDiag?.details).toMatchObject({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			errorClassification: "anthropic_thinking_signature_mismatch",
			retryOccurred: true,
			retrySucceeded: true,
		});
	});

	it("2. recovers OpenAI encrypted reasoning rejected during verification and disassociates tool call IDs", async () => {
		const bodies: Record<string, unknown>[] = [];
		const rejectedItemId = "rs_05c201919ea70b40016acb54c528d0819595640c53c86c884c";

		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			bodies.push(JSON.parse(await request.clone().text()) as Record<string, unknown>);
			if (bodies.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							code: "invalid_encrypted_content",
							message: `The encrypted content for item ${rejectedItemId} could not be verified. Reason: Encrypted content could not be decrypted or parsed.`,
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return createOpenAISuccessResponse();
		});

		const context: TranscriptContext = normalizeContext({
			messages: [
				{ role: "user", content: "perform calculation", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "",
							thinkingSignature: JSON.stringify({
								type: "reasoning",
								id: rejectedItemId,
								encrypted_content: "gAAAAAB-bad-content",
								summary: [],
							}),
						},
						{
							type: "toolCall",
							id: "call_calc_1|fc_item_123",
							name: "calculator",
							arguments: { expr: "2+2" },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5-mini",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_calc_1|fc_item_123",
					toolName: "calculator",
					content: [{ type: "text", text: "4" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "what was the result?", timestamp: 4 },
			],
		});

		const result = await streamOpenAIResponses(openaiModel, context, { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// First request had the reasoning item and function_call with id
		const firstInput = bodies[0].input as Array<{ type: string; id?: string }>;
		expect(firstInput.some((item) => item.type === "reasoning" && item.id === rejectedItemId)).toBe(true);

		// Second request stripped reasoning AND disassociated the function_call item id (set to undefined)
		const secondInput = bodies[1].input as Array<{ type: string; id?: string; call_id?: string }>;
		expect(secondInput.some((item) => item.type === "reasoning")).toBe(false);
		const functionCallItem = secondInput.find((item) => item.type === "function_call");
		expect(functionCallItem).toBeDefined();
		expect(functionCallItem?.id).toBeUndefined(); // id omitted to prevent pairing validation failure!
		expect(functionCallItem?.call_id).toBe("call_calc_1");

		// Diagnostic check
		const diag = result.diagnostics?.find((d) => d.type === "reasoning_recovery");
		expect(diag).toBeDefined();
		expect(diag?.details).toMatchObject({
			errorClassification: "openai_invalid_encrypted_content",
			affectedItemId: rejectedItemId,
			retryOccurred: true,
			retrySucceeded: true,
		});
	});

	it("3. converts reasoning to text across incompatible providers and models without replaying opaque signatures", () => {
		const anthropicAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "detailed reasoning", thinkingSignature: "anthropic-sig-456" },
				{ type: "text", text: "answer" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};

		// Case A: Switched to OpenAI
		const transformedForOpenAI = transformMessages([anthropicAssistant], openaiModel);
		const assistantA = transformedForOpenAI[0] as AssistantMessage;
		// Thinking block must be converted to plain text, not replayed as thinking
		expect(assistantA.content.some((b) => b.type === "thinking")).toBe(false);
		const textBlocks = assistantA.content.filter((b) => b.type === "text") as TextContent[];
		expect(textBlocks.some((b) => b.text === "detailed reasoning")).toBe(true);

		// Case B: Switched to another Anthropic model (e.g. Claude Opus 4.6)
		const otherAnthropicModel: Model<"anthropic-messages"> = {
			...anthropicModel,
			id: "claude-opus-4-6",
		};
		const transformedForOtherAnthropic = transformMessages([anthropicAssistant], otherAnthropicModel);
		const assistantB = transformedForOtherAnthropic[0] as AssistantMessage;
		expect(assistantB.content.some((b) => b.type === "thinking")).toBe(false);
		expect(assistantB.content.some((b) => b.type === "text" && b.text === "detailed reasoning")).toBe(true);

		// Case C: Empty thinking (like OpenAI encrypted reasoning with empty text) across models
		const openAIAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_123", encrypted_content: "enc" }),
				},
				{ type: "text", text: "hello" },
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5-mini",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		const transformedCross = transformMessages([openAIAssistant], anthropicModel);
		const assistantC = transformedCross[0] as AssistantMessage;
		// Empty reasoning is completely omitted, text preserved
		expect(assistantC.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("4. proactively sanitizes thinking blocks when conversation compaction is present for models without binding controls", () => {
		const compactionMessage: Message = {
			role: "user",
			content:
				"The conversation history before this point was compacted into the following summary:\nUser asked for help with refactoring.",
			timestamp: 5,
		};
		const assistantWithThinking: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "I should follow up on the refactoring",
					thinkingSignature: "sig-pre-compaction",
				},
				{ type: "text", text: "Here is the next step" },
			],
			api: anthropicModel.api,
			provider: anthropicModel.provider,
			model: anthropicModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 6,
		};

		expect(isConversationCompacted([compactionMessage, assistantWithThinking])).toBe(true);

		// Transform for standard Sonnet (no server-side binding controls declared in model compat)
		const transformed = transformMessages([compactionMessage, assistantWithThinking], anthropicModel);
		const assistantAfter = transformed[1] as AssistantMessage;

		// Thinking block must be converted to plain text so Anthropic does not fail on stale signature
		expect(assistantAfter.content.some((b) => b.type === "thinking")).toBe(false);
		const textBlocks = assistantAfter.content.filter((b) => b.type === "text") as TextContent[];
		expect(textBlocks.map((t) => t.text)).toEqual(["I should follow up on the refactoring", "Here is the next step"]);
	});

	it("5. preserves mixed assistant text, reasoning, and tool-call histories and disassociates toolCall ids when reasoning omitted", () => {
		const assistantWithAll: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({
						type: "reasoning",
						id: "rs_multi_item",
						encrypted_content: "enc_data",
					}),
				},
				{ type: "text", text: "I will call the tool now." },
				{
					type: "toolCall",
					id: "call_abc|fc_item_789",
					name: "search",
					arguments: { q: "test" },
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5-mini",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};

		const context = normalizeContext({
			messages: [
				{ role: "user", content: "run search", timestamp: 0 },
				assistantWithAll,
				{
					role: "toolResult",
					toolCallId: "call_abc|fc_item_789",
					toolName: "search",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: 2,
				},
			],
		});

		// When stripReasoning is true (e.g. during recovery)
		const converted = convertResponsesMessages(openaiModel, context, new Set(["openai"]), { stripReasoning: true });

		// Reasoning item is omitted
		expect(converted.some((item) => item.type === "reasoning")).toBe(false);

		// Text message is preserved
		const textItem = converted.find((item) => item.type === "message") as any;
		expect(textItem).toBeDefined();
		expect(textItem.content[0].text).toBe("I will call the tool now.");

		// Function call is preserved BUT id is undefined to disassociate from missing rs_ item!
		const toolItem = converted.find((item) => item.type === "function_call") as any;
		expect(toolItem).toBeDefined();
		expect(toolItem.name).toBe("search");
		expect(toolItem.call_id).toBe("call_abc");
		expect(toolItem.id).toBeUndefined();
	});

	it("6. omits errored and aborted assistant messages to prevent incomplete/orphaned reasoning replay", () => {
		const abortedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "partial thought", thinkingSignature: "sig-aborted" }],
			api: anthropicModel.api,
			provider: anthropicModel.provider,
			model: anthropicModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: 1,
		};
		const erroredAssistant: AssistantMessage = {
			...abortedAssistant,
			stopReason: "error",
			timestamp: 2,
		};

		const messages: Message[] = [
			{ role: "user", content: "query 1", timestamp: 0 },
			abortedAssistant,
			{ role: "user", content: "query 2", timestamp: 3 },
			erroredAssistant,
			{ role: "user", content: "query 3", timestamp: 4 },
		];

		const transformed = transformMessages(messages, anthropicModel);
		// Both aborted and errored messages must be skipped
		expect(transformed.some((m) => m.role === "assistant")).toBe(false);
		expect(transformed.map((m) => m.role)).toEqual(["user", "user", "user"]);
	});

	it("7. keeps valid reasoning history unchanged for the same model", () => {
		const validAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "valid thought", thinkingSignature: "sig-valid-turn-1" },
				{ type: "text", text: "valid answer" },
			],
			api: anthropicModel.api,
			provider: anthropicModel.provider,
			model: anthropicModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};

		const messages: Message[] = [{ role: "user", content: "prompt", timestamp: 0 }, validAssistant];

		const transformed = transformMessages(messages, anthropicModel);
		expect(transformed).toHaveLength(2);
		const assistant = transformed[1] as AssistantMessage;
		expect(assistant.content[0]).toEqual({
			type: "thinking",
			thinking: "valid thought",
			thinkingSignature: "sig-valid-turn-1",
		});
		expect(assistant.content[1]).toEqual({
			type: "text",
			text: "valid answer",
		});
	});

	it("8. fails gracefully without infinite retry loops when recovery retry also fails", async () => {
		const attempts: number[] = [];
		const fetchMock = vi.fn().mockImplementation(async () => {
			attempts.push(Date.now());
			// Both the initial attempt and the recovery attempt return 400
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: "invalid_request_error",
						message: "Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
					},
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		});

		const context: TranscriptContext = normalizeContext({
			messages: [
				{ role: "user", content: "initial prompt", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "thought", thinkingSignature: "sig-fail" },
						{ type: "text", text: "reply" },
					],
					api: anthropicModel.api,
					provider: anthropicModel.provider,
					model: anthropicModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{ role: "user", content: "second prompt", timestamp: 2 },
			],
		});

		const result = await streamAnthropicMessages(anthropicModel, context, {
			apiKey: "test-key",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		// Exactly 2 attempts: 1 initial + 1 retry (NO infinite loop!)
		expect(attempts).toHaveLength(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Anthropic signature recovery failed");

		// Diagnostic recorded with retrySucceeded: false
		const diag = result.diagnostics?.find((d) => d.type === "reasoning_recovery");
		expect(diag).toBeDefined();
		expect(diag?.details).toMatchObject({
			retryOccurred: true,
			retrySucceeded: false,
		});
	});

	it("9. preserves canonical conversation history intact when retry uses sanitized history", async () => {
		const fetchMock = vi.fn().mockImplementation(async () => {
			if (fetchMock.mock.calls.length === 1) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message: "Invalid `signature` in `thinking` block.",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return createAnthropicSuccessResponse();
		});

		const originalAssistantContent = [
			{ type: "thinking" as const, thinking: "canonical thought", thinkingSignature: "canonical-sig" },
			{ type: "text" as const, text: "canonical text" },
		];
		const context: TranscriptContext = normalizeContext({
			messages: [
				{ role: "user", content: "first", timestamp: 0 },
				{
					role: "assistant",
					content: [...originalAssistantContent],
					api: anthropicModel.api,
					provider: anthropicModel.provider,
					model: anthropicModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{ role: "user", content: "second", timestamp: 2 },
			],
		});

		// Deep snapshot of the original context before execution
		const snapshot = JSON.stringify(context.messages);

		await streamAnthropicMessages(anthropicModel, context, {
			apiKey: "test-key",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		// Canonical history must NOT have been mutated
		expect(JSON.stringify(context.messages)).toBe(snapshot);
	});

	it("10. extracts error details accurately for both error classes", () => {
		// Anthropic details extraction
		const anthropicMsg =
			"messages.2.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Content that preceded this block when it was created is missing from this request, starting at `messages.1.content.0`.";
		expect(isAnthropicThinkingSignatureError(anthropicMsg)).toBe(true);
		const anthropicDetails = extractAnthropicThinkingSignatureErrorDetails(anthropicMsg);
		expect(anthropicDetails.path).toBe("messages.2.content.0");
		expect(anthropicDetails.messageIndex).toBe(2);
		expect(anthropicDetails.contentIndex).toBe(0);
		expect(anthropicDetails.divergencePath).toBe("messages.1.content.0");
		expect(anthropicDetails.divergenceIndex).toBe(1);

		// OpenAI details extraction
		const openaiError = {
			code: "invalid_encrypted_content",
			message:
				"The encrypted content for item rs_abcdef123456 could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
		};
		expect(isInvalidEncryptedContentError(openaiError)).toBe(true);
		const itemId = extractInvalidEncryptedContentItemId(openaiError);
		expect(itemId).toBe("rs_abcdef123456");
	});
});
