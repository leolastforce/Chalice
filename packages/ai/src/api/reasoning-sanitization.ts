import type { AssistantMessage, Message } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";

const MAX_INVALIDATED_ENTRIES = 1000;

class BoundedStringSet {
	private items = new Set<string>();

	add(item: string): void {
		if (!item) return;
		if (this.items.size >= MAX_INVALIDATED_ENTRIES) {
			const oldest = this.items.keys().next().value;
			if (oldest !== undefined) this.items.delete(oldest);
		}
		this.items.add(item);
	}

	has(item: string): boolean {
		return this.items.has(item);
	}

	clear(): void {
		this.items.clear();
	}

	get size(): number {
		return this.items.size;
	}

	[Symbol.iterator](): IterableIterator<string> {
		return this.items.values();
	}
}

const invalidatedReasoningItemIds = new BoundedStringSet();
const invalidatedThinkingSignatures = new BoundedStringSet();

export function markReasoningItemInvalidated(itemId: string): void {
	if (itemId) {
		invalidatedReasoningItemIds.add(itemId);
	}
}

export function isReasoningItemInvalidated(itemId: string): boolean {
	return invalidatedReasoningItemIds.has(itemId);
}

export function isReasoningSignatureInvalidated(signature: string | undefined): boolean {
	if (!signature) return false;
	for (const id of invalidatedReasoningItemIds) {
		if (signature.includes(id)) return true;
	}
	return false;
}

export function markThinkingSignatureInvalidated(signature: string): void {
	if (signature) {
		invalidatedThinkingSignatures.add(signature);
	}
}

export function isThinkingSignatureInvalidated(signature: string | undefined): boolean {
	if (!signature) return false;
	return invalidatedThinkingSignatures.has(signature);
}

export function clearInvalidatedReasoningState(): void {
	invalidatedReasoningItemIds.clear();
	invalidatedThinkingSignatures.clear();
}

/**
 * Detect Anthropic thinking block signature invalidation / prefix mismatch errors.
 * Anthropic rejects requests where a replayed thinking block signature was generated
 * against a different conversation prefix (e.g. after mode switches, compaction, or rewinds).
 */
export function isAnthropicThinkingSignatureError(error: unknown): boolean {
	const message =
		typeof error === "object" && error !== null
			? ((error as { message?: unknown; error?: { message?: unknown } }).error?.message ??
				(error as { message?: unknown }).message)
			: String(error);
	if (typeof message !== "string") return false;
	return (
		/invalid\s+[`'"]?signature[`'"]?\s+in\s+[`'"]?thinking[`'"]?\s+block/i.test(message) ||
		message.includes("prefix_mismatch_behavior") ||
		message.includes("The block is bound to a different conversation") ||
		message.includes("Content that preceded this block when it was created is missing") ||
		message.includes("The system prompt differs") ||
		message.includes("prefix_binding_mismatch") ||
		message.includes("model_binding_mismatch") ||
		message.includes("thinking-binding-controls")
	);
}

export interface AnthropicSignatureErrorDetails {
	path?: string;
	messageIndex?: number;
	contentIndex?: number;
	divergencePath?: string;
	divergenceIndex?: number;
}

export function extractAnthropicThinkingSignatureErrorDetails(error: unknown): AnthropicSignatureErrorDetails {
	const message =
		typeof error === "object" && error !== null
			? ((error as { message?: unknown; error?: { message?: unknown } }).error?.message ??
				(error as { message?: unknown }).message)
			: String(error);
	if (typeof message !== "string") return {};

	const details: AnthropicSignatureErrorDetails = {};
	const pathMatch = /messages\.(\d+)\.content\.(\d+)/.exec(message);
	if (pathMatch) {
		details.path = pathMatch[0];
		details.messageIndex = Number.parseInt(pathMatch[1], 10);
		details.contentIndex = Number.parseInt(pathMatch[2], 10);
	}
	const divergenceMatch = /starting\s+at\s+[`'"]?messages\.(\d+)\.content\.(\d+)/i.exec(message);
	if (divergenceMatch) {
		details.divergencePath = `messages.${divergenceMatch[1]}.content.${divergenceMatch[2]}`;
		details.divergenceIndex = Number.parseInt(divergenceMatch[1], 10);
	}
	return details;
}

/**
 * Detect OpenAI Responses `invalid_encrypted_content` rejections.
 *
 * The Responses API rejects a request when a replayed `reasoning` item's
 * `encrypted_content` cannot be decrypted under the organization/key/deployment
 * that serves the current request.
 */
export function isInvalidEncryptedContentError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		if (typeof error === "object" && error !== null) {
			const candidate = error as {
				code?: unknown;
				error?: { code?: unknown; message?: unknown };
				message?: unknown;
			};
			if (candidate.code === "invalid_encrypted_content") return true;
			if (candidate.error?.code === "invalid_encrypted_content") return true;
			if (typeof candidate.message === "string" && candidate.message.includes("invalid_encrypted_content"))
				return true;
			if (
				typeof candidate.error?.message === "string" &&
				candidate.error.message.includes("invalid_encrypted_content")
			)
				return true;
		}
		return false;
	}
	const candidate = error as { code?: unknown; error?: unknown; message?: unknown };
	if (candidate.code === "invalid_encrypted_content") return true;
	const nested = candidate.error;
	if (
		typeof nested === "object" &&
		nested !== null &&
		(nested as { code?: unknown }).code === "invalid_encrypted_content"
	) {
		return true;
	}
	return (
		typeof candidate.message === "string" &&
		(candidate.message.includes("invalid_encrypted_content") || candidate.message.includes("could not be verified"))
	);
}

export function extractInvalidEncryptedContentItemId(error: unknown): string | undefined {
	const message =
		typeof error === "object" && error !== null
			? ((error as { message?: unknown; error?: { message?: unknown } }).error?.message ??
				(error as { message?: unknown }).message)
			: String(error);
	if (typeof message !== "string") return undefined;
	const match = /(?:item|reasoning)?\s*[`'"]?\s*(rs_[a-zA-Z0-9_-]+)/i.exec(message);
	return match ? match[1] : undefined;
}

export function isConversationCompacted(messages: Message[]): boolean {
	return messages.some((m) => {
		if (m.role === "user") {
			if (typeof m.content === "string") {
				return (
					m.content.includes("The conversation history before this point was compacted") ||
					m.content.includes("[The conversation prior to this point was compacted")
				);
			}
			if (Array.isArray(m.content)) {
				return m.content.some(
					(c) =>
						c.type === "text" &&
						(c.text.includes("The conversation history before this point was compacted") ||
							c.text.includes("[The conversation prior to this point was compacted")),
				);
			}
		}
		return false;
	});
}

export interface ReasoningRecoveryDiagnosticDetails {
	provider: string;
	model: string;
	api: string;
	errorClassification: "anthropic_thinking_signature_mismatch" | "openai_invalid_encrypted_content" | string;
	sanitizationReason: "prefix_binding_mismatch" | "unverified_encrypted_content" | "compaction_prefix_shift" | string;
	affectedBlockTypes: string[];
	affectedItemId?: string;
	affectedSignatureCount?: number;
	retryOccurred: boolean;
	retrySucceeded: boolean;
}

export function recordReasoningRecoveryDiagnostic(
	output: AssistantMessage,
	details: ReasoningRecoveryDiagnosticDetails,
): void {
	appendAssistantMessageDiagnostic(output, {
		type: "reasoning_recovery",
		timestamp: Date.now(),
		details: { ...details },
	});
}
