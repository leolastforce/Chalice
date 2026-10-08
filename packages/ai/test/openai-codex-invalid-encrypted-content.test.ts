import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { AssistantMessage, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	closeOpenAICodexWebSocketSessions();
	vi.restoreAllMocks();
});

function mockToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const reasoningItem = {
	type: "reasoning",
	id: "rs_stale",
	summary: [],
	encrypted_content: "gAAAAAB-stale-encrypted-content",
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

function decodeRequestBody(body: RequestInit["body"] | undefined): { input?: Array<{ type?: string }> } {
	if (typeof body === "string") return JSON.parse(body) as { input?: Array<{ type?: string }> };
	if (body instanceof Uint8Array) {
		return JSON.parse(Buffer.from(zstdDecompressSync(body)).toString("utf8")) as {
			input?: Array<{ type?: string }>;
		};
	}
	throw new Error("Unexpected Codex request body");
}

function invalidEncryptedContentResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message:
					"The encrypted content for item rs_stale could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
				type: "invalid_request_error",
				code: "invalid_encrypted_content",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function completedResponse(): Response {
	const event = {
		type: "response.completed",
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
	return new Response(`data: ${JSON.stringify(event)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("openai-codex invalid_encrypted_content recovery", () => {
	it("retries the turn without reasoning after a 400 invalid_encrypted_content", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-encrypted-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;

		const bodies: Array<{ input?: Array<{ type?: string }> }> = [];
		const fetchMock = vi.fn(async (_input: string | Request | URL, init?: RequestInit) => {
			bodies.push(decodeRequestBody(init?.body));
			return bodies.length === 1 ? invalidEncryptedContentResponse() : completedResponse();
		});

		const result = await streamOpenAICodexResponses(model, contextWithReasoning(), {
			apiKey: mockToken(),
			transport: "sse",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(bodies[0]?.input?.some((item) => item.type === "reasoning")).toBe(true);
		expect(bodies[1]?.input?.some((item) => item.type === "reasoning")).toBe(false);
	});
});
