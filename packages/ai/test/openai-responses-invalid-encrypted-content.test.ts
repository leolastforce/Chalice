import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import {
	convertResponsesMessages,
	hasReasoningReplayContextShift,
	isInvalidEncryptedContentError,
	retryWithoutEncryptedReasoning,
} from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
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

const reasoningItem = {
	type: "reasoning",
	id: "rs_bad_org",
	summary: [],
	encrypted_content: "gAAAAAB-encrypted-content",
};

function assistantWithReasoning(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoningItem) }],
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

function contextWithReasoning(): TranscriptContext {
	return normalizeContext({
		messages: [
			{ role: "user", content: "first", timestamp: 0 },
			assistantWithReasoning(),
			{ role: "user", content: "follow-up", timestamp: 2 },
		],
	});
}

function completedResponse(): Response {
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

function invalidEncryptedContentResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message:
					"The encrypted content for item rs_bad_org could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
				type: "invalid_request_error",
				code: "invalid_encrypted_content",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

describe("OpenAI Responses invalid_encrypted_content recovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("strips replay proactively after a credential or routing shift", () => {
		const sessionId = "proactive-shift-test";
		expect(hasReasoningReplayContextShift(sessionId, "openai|key-a")).toBe(false);
		expect(hasReasoningReplayContextShift(sessionId, "openai|key-a")).toBe(false);
		expect(hasReasoningReplayContextShift(sessionId, "openai|key-b")).toBe(true);
	});

	it("recognizes invalid_encrypted_content errors", () => {
		const codeError = Object.assign(new Error("400 bad request"), {
			status: 400,
			code: "invalid_encrypted_content",
		});
		const nestedError = Object.assign(new Error("400 bad request"), {
			status: 400,
			error: { code: "invalid_encrypted_content" },
		});
		const messageError = Object.assign(new Error("400 The encrypted content for item rs_x could not be verified."), {
			status: 400,
		});

		expect(isInvalidEncryptedContentError(codeError)).toBe(true);
		expect(isInvalidEncryptedContentError(nestedError)).toBe(true);
		expect(isInvalidEncryptedContentError(messageError)).toBe(true);
		expect(isInvalidEncryptedContentError(Object.assign(new Error("400"), { status: 400 }))).toBe(false);
		expect(isInvalidEncryptedContentError(Object.assign(new Error("429"), { status: 429 }))).toBe(false);
		// The Codex backend reports the same rejection as a `response.failed` event
		// with a code but no HTTP status, so detection must not require a 400.
		expect(
			isInvalidEncryptedContentError(
				Object.assign(new Error("Codex response failed"), { code: "invalid_encrypted_content" }),
			),
		).toBe(true);
		expect(isInvalidEncryptedContentError(new Error("invalid_encrypted_content"))).toBe(true);
	});

	it("retries once with reasoning stripped only on invalid_encrypted_content", async () => {
		const seen: boolean[] = [];
		const recovered = await retryWithoutEncryptedReasoning(async (stripReasoning) => {
			seen.push(stripReasoning);
			if (!stripReasoning) throw Object.assign(new Error("400"), { status: 400, code: "invalid_encrypted_content" });
			return "ok";
		});
		expect(recovered).toBe("ok");
		expect(seen).toEqual([false, true]);

		const fatal = Object.assign(new Error("429"), { status: 429 });
		await expect(
			retryWithoutEncryptedReasoning(async () => {
				throw fatal;
			}),
		).rejects.toBe(fatal);
	});

	it("drops reasoning items when stripReasoning is set", () => {
		const context = contextWithReasoning();
		const withReasoning = convertResponsesMessages(model, context, new Set(["openai"]));
		expect(withReasoning.some((item) => item.type === "reasoning")).toBe(true);

		const stripped = convertResponsesMessages(model, context, new Set(["openai"]), { stripReasoning: true });
		expect(stripped.some((item) => item.type === "reasoning")).toBe(false);
	});

	it("retries the request without reasoning items after a 400", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			bodies.push(JSON.parse(await request.clone().text()) as Record<string, unknown>);
			return bodies.length === 1 ? invalidEncryptedContentResponse() : completedResponse();
		});

		const result = await streamOpenAIResponses(model, contextWithReasoning(), {
			apiKey: "test-key",
		}).result();

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const firstInput = bodies[0].input as Array<{ type: string }>;
		expect(firstInput.some((item) => item.type === "reasoning")).toBe(true);

		const secondInput = bodies[1].input as Array<{ type: string }>;
		expect(secondInput.some((item) => item.type === "reasoning")).toBe(false);
	});
});
