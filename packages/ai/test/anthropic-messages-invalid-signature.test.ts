import { afterEach, describe, expect, it, vi } from "vitest";
import {
	hasThinkingBlocksInAnthropicMessages,
	isAnthropicThinkingSignatureError,
	stream as streamAnthropicMessages,
	stripThinkingFromAnthropicMessages,
} from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = {
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

function assistantWithThinking(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "some thought", thinkingSignature: "valid-sig-123" },
			{ type: "text", text: "Hello there!" },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
}

function contextWithThinking(): TranscriptContext {
	return normalizeContext({
		messages: [
			{ role: "user", content: "initial prompt", timestamp: 0 },
			assistantWithThinking(),
			{ role: "user", content: "follow-up prompt", timestamp: 2 },
		],
	});
}

function anthropicSuccessResponse(): Response {
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
			delta: { type: "text_delta", text: "Recovered successfully" },
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

function anthropicInvalidSignatureResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. Content that preceded this block when it was created is missing from this request, starting at `messages.0.content.0`.',
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

describe("Anthropic Messages invalid signature recovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("identifies invalid thinking signature errors", () => {
		const rawError = new Error(
			"messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
		);
		const nestedError = {
			error: {
				message: 'Invalid "signature" in "thinking" block. Set prefix_mismatch_behavior to drop_block.',
			},
		};
		const unrelatedError = new Error("Rate limit exceeded (429)");

		expect(isAnthropicThinkingSignatureError(rawError)).toBe(true);
		expect(isAnthropicThinkingSignatureError(nestedError)).toBe(true);
		expect(isAnthropicThinkingSignatureError(unrelatedError)).toBe(false);
		expect(isAnthropicThinkingSignatureError(null)).toBe(false);
	});

	it("checks for presence of thinking blocks in Anthropic messages", () => {
		const withThinking = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
			{
				role: "assistant" as const,
				content: [
					{ type: "thinking" as const, thinking: "...", signature: "sig" },
					{ type: "text" as const, text: "reply" },
				],
			},
		];
		const withoutThinking = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
			{ role: "assistant" as const, content: [{ type: "text" as const, text: "reply" }] },
		];

		expect(hasThinkingBlocksInAnthropicMessages(withThinking as never)).toBe(true);
		expect(hasThinkingBlocksInAnthropicMessages(withoutThinking as never)).toBe(false);
		expect(hasThinkingBlocksInAnthropicMessages([])).toBe(false);
	});

	it("strips thinking blocks while preserving text and tool_use", () => {
		const messages = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
			{
				role: "assistant" as const,
				content: [
					{ type: "thinking" as const, thinking: "thought", signature: "sig" },
					{ type: "text" as const, text: "preserved text" },
				],
			},
		];
		const stripped = stripThinkingFromAnthropicMessages(messages as never);
		expect(stripped[0]).toEqual(messages[0]);
		expect(stripped[1].content).toEqual([{ type: "text", text: "preserved text" }]);
	});

	it("retries request without thinking blocks upon signature invalidation 400", async () => {
		const bodies: unknown[] = [];
		const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
			if (typeof init?.body === "string") {
				bodies.push(JSON.parse(init.body));
			}
			if (bodies.length === 1) {
				return anthropicInvalidSignatureResponse();
			}
			return anthropicSuccessResponse();
		});

		const context = contextWithThinking();
		const result = await streamAnthropicMessages(model, context, {
			apiKey: "test-key",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Recovered successfully" }]);

		// First request contained thinking block in assistant message
		const firstPayload = bodies[0] as { messages: Array<{ role: string; content: Array<{ type: string }> }> };
		const firstAssistant = firstPayload.messages.find((m) => m.role === "assistant");
		expect(firstAssistant?.content.some((b) => b.type === "thinking")).toBe(true);

		// Second request stripped thinking block
		const secondPayload = bodies[1] as { messages: Array<{ role: string; content: Array<{ type: string }> }> };
		const secondAssistant = secondPayload.messages.find((m) => m.role === "assistant");
		expect(secondAssistant?.content.some((b) => b.type === "thinking")).toBe(false);
		expect(secondAssistant?.content.some((b) => b.type === "text")).toBe(true);
	});

	it("does not retry if caller explicitly configured prefix_mismatch_behavior to error", async () => {
		const fetchMock = vi.fn().mockImplementation(async () => {
			return anthropicInvalidSignatureResponse();
		});

		const context = contextWithThinking();
		const result = await streamAnthropicMessages(model, context, {
			apiKey: "test-key",
			fetch: fetchMock as unknown as typeof fetch,
			onPayload: (payload) => {
				const params = payload as {
					thinking?: { type?: string; block_binding?: { prefix_mismatch_behavior?: string } };
				};
				params.thinking = {
					type: "adaptive",
					block_binding: { prefix_mismatch_behavior: "error" },
				};
				return params;
			},
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid `signature` in `thinking` block");
	});
});
