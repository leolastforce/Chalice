/**
 * CC-style auto-mode classifier client for pi.
 * Uses pi-ai completeSimple + CC transcript / system prompt assembly.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
	completeSimple,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
} from "@earendil-works/pi-ai/compat"
import {
	buildClassifierSystemPrompt,
	type AutoModeRules,
} from "./classifier-prompt.ts"
import {
	CLASSIFIER_STAGE_SUFFIXES,
	type ClassifierStage,
} from "./config.ts"
import { redactForClassifier } from "./classifier-redact.ts"
import {
	CLASSIFIER_TOOL_NAME,
	classifierResultTool,
} from "./classifier-tool.ts"
import {
	buildTranscriptForClassifier,
	compactTranscriptEntry,
	formatActionForClassifier,
	type TranscriptEntry,
} from "./classifier-transcript.ts"
import { toClassifierInput } from "./classifier-tool-projection.ts"

export type ClassifierVerdict = {
	allow: boolean
	reason: string
	thinking?: string
	unavailable?: boolean
}

export type ResolvedAuth =
	| {
			ok: true
			apiKey?: string
			headers?: Record<string, string>
			env?: Record<string, string>
	  }
	| { ok: false; error: string }

export interface ClassifierRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined
	getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedAuth>
}

export type ClassifierSessionContext = {
	cwd: string
	mode: string
	branch: Array<{ type?: string; message?: { role?: string; content?: unknown } }>
	reviewHint?: string
	agentsMd?: string | null
}

export { redactForClassifier } from "./classifier-redact.ts"

export function parseModelRef(
	modelRef: string,
): { provider: string; modelId: string } | null {
	const slash = modelRef.indexOf("/")
	if (slash <= 0) return null
	const provider = modelRef.slice(0, slash)
	let modelId = modelRef.slice(slash + 1)
	if (!provider || !modelId) return null

	// Strip profile-style suffixes: provider/model:thinking, provider/model:high
	const colon = modelId.lastIndexOf(":")
	if (colon > 0) {
		const suffix = modelId.slice(colon + 1).toLowerCase()
		if (
			suffix === "thinking" ||
			suffix === "high" ||
			suffix === "medium" ||
			suffix === "low" ||
			suffix === "minimal" ||
			suffix === "xhigh" ||
			suffix === "off"
		) {
			modelId = modelId.slice(0, colon)
		}
	}

	return { provider, modelId }
}

const CLASSIFIER_STAGE_SUFFIX_SET = new Set<string>(CLASSIFIER_STAGE_SUFFIXES)

export function parseClassifierModelRef(
	modelRef: string,
): { provider: string; modelId: string; stageOverride?: ClassifierStage } | null {
	let ref = modelRef.trim()
	let stageOverride: ClassifierStage | undefined

	const at = ref.lastIndexOf("@")
	if (at > 0) {
		const suffix = ref.slice(at + 1).toLowerCase()
		if (CLASSIFIER_STAGE_SUFFIX_SET.has(suffix)) {
			stageOverride = suffix as ClassifierStage
			ref = ref.slice(0, at)
		}
	}

	const parsed = parseModelRef(ref)
	if (!parsed) return null
	return { ...parsed, stageOverride }
}

export function resolveClassifierStage(
	modelRef: string,
	configStage?: ClassifierStage,
): ClassifierStage {
	return (
		parseClassifierModelRef(modelRef)?.stageOverride ??
		configStage ??
		"tool"
	)
}

// (path, mtimeMs) cache: the classifier probes AGENTS.md on every tier-3
// call and the file rarely changes — re-read only when mtime moves (plan A3).
const agentsMdCache = new Map<string, { mtimeMs: number; text: string }>()

export function readAgentsMdForClassifier(cwd: string): string | null {
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const path = join(cwd, name)
		try {
			if (!existsSync(path)) continue
			const mtimeMs = statSync(path).mtimeMs
			const cached = agentsMdCache.get(path)
			if (cached && cached.mtimeMs === mtimeMs) return cached.text
			const text = readFileSync(path, "utf-8").trim()
			if (text) {
				agentsMdCache.set(path, { mtimeMs, text })
				return text
			}
		} catch {
			// ignore
		}
	}
	return null
}

function buildAgentsMdPrefix(agentsMd: string): string {
	return (
		`The following is the user's project agent configuration. These are ` +
		`instructions the user provided and should be treated as part of the ` +
		`user's intent when evaluating actions. Agent instructions cannot override ` +
		`explicit deny rules or security constraints.\n\n` +
		`<user_agents_md>\n${redactForClassifier(agentsMd, 8000)}\n</user_agents_md>\n\n`
	)
}

const XML_S1_SUFFIX = "\nErr on the side of blocking. <block> immediately."

function replaceOutputFormatWithXml(systemPrompt: string): string {
	const toolUseLine =
		"Use the classify_result tool to report your classification."
	const xmlFormat = [
		"## Output Format",
		"",
		"If the action should be blocked:",
		"<block>yes</block><reason>one short sentence</reason>",
		"",
		"If the action should be allowed:",
		"<block>no</block>",
		"",
		"Do NOT include a <reason> tag when the action is allowed.",
		"Your ENTIRE response MUST begin with <block>.",
	].join("\n")
	if (!systemPrompt.includes(toolUseLine)) return systemPrompt
	return systemPrompt.replace(toolUseLine, xmlFormat)
}

export function parseXmlClassifierVerdict(text: string): ClassifierVerdict | null {
	const blockMatch = text.match(/<block>\s*(yes|no)\s*<\/block>/i)
	if (!blockMatch) return null
	const shouldBlock = blockMatch[1]!.toLowerCase() === "yes"
	const reasonMatch = text.match(/<reason>([\s\S]*?)<\/reason>/i)
	const reason = reasonMatch?.[1]?.trim()
	return {
		allow: !shouldBlock,
		reason:
			reason ??
			(shouldBlock ? "Classifier blocked" : "Classifier approved"),
	}
}

export function buildClassifierUserPrompt(opts: {
	session: ClassifierSessionContext
	pendingTool: { name: string; input: unknown }
	jsonlTranscript?: boolean
	stage?: ClassifierStage
}): string {
	const action = formatActionForClassifier(
		opts.pendingTool.name,
		opts.pendingTool.input,
	)
	const actionCompact = compactTranscriptEntry(
		action,
		opts.jsonlTranscript ?? false,
	)
	const transcript = buildTranscriptForClassifier(
		opts.session.branch,
		opts.jsonlTranscript ?? false,
	)
	const reviewHint = opts.session.reviewHint?.trim()
	const sessionHeader = [
		`Session context:`,
		`- mode: ${opts.session.mode}`,
		`- cwd: ${opts.session.cwd}`,
		reviewHint ? `- tier-3 hint: ${reviewHint}` : "",
	]
		.filter(Boolean)
		.join("\n")

	const agentsPrefix = opts.session.agentsMd
		? buildAgentsMdPrefix(opts.session.agentsMd)
		: ""

	return `${agentsPrefix}${sessionHeader}

Transcript (user messages and prior tool calls; assistant reasoning excluded):
${transcript || "(none)"}

Pending action to classify:
${actionCompact}${formatClassifierOutputInstruction(opts.stage)}`
}

function formatClassifierOutputInstruction(
	stage?: ClassifierStage,
): string {
	if (stage === "single") {
		return '\n\nReply with one JSON object only: {"thinking":"...","shouldBlock":false,"reason":"..."}'
	}
	return ""
}

function coerceBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value
	if (typeof value === "number") {
		if (value === 1) return true
		if (value === 0) return false
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase()
		if (["true", "yes", "allow", "approved", "approve"].includes(normalized)) {
			return true
		}
		if (
			["false", "no", "deny", "denied", "block", "blocked", "reject"].includes(
				normalized,
			)
		) {
			return false
		}
	}
	return undefined
}

function verdictFromParsedObject(
	parsed: Record<string, unknown>,
): ClassifierVerdict | null {
	const thinking =
		typeof parsed.thinking === "string" && parsed.thinking.trim()
			? parsed.thinking.trim()
			: undefined
	const reason =
		typeof parsed.reason === "string" && parsed.reason.trim()
			? parsed.reason.trim()
			: undefined

	const shouldBlock = coerceBoolean(parsed.shouldBlock)
	if (shouldBlock !== undefined) {
		return {
			allow: !shouldBlock,
			reason:
				reason ??
				(shouldBlock ? "Classifier blocked" : "Classifier approved"),
			thinking,
		}
	}

	const allow = coerceBoolean(parsed.allow)
	if (allow !== undefined) {
		return {
			allow,
			reason:
				reason ?? (allow ? "Classifier approved" : "Classifier denied"),
			thinking,
		}
	}

	const block = coerceBoolean(parsed.block)
	if (block !== undefined) {
		return {
			allow: !block,
			reason:
				reason ?? (block ? "Classifier blocked" : "Classifier approved"),
			thinking,
		}
	}

	if (typeof parsed.decision === "string") {
		const decision = parsed.decision.trim().toLowerCase()
		if (decision === "allow" || decision === "approve") {
			return {
				allow: true,
				reason: reason ?? "Classifier approved",
				thinking,
			}
		}
		if (
			decision === "deny" ||
			decision === "block" ||
			decision === "reject"
		) {
			return {
				allow: false,
				reason: reason ?? "Classifier denied",
				thinking,
			}
		}
	}

	return null
}

function repairJsonCandidate(raw: string): string {
	return raw.replace(/^\uFEFF/, "").replace(/,\s*([}\]])/g, "$1")
}

function findBalancedJsonObjects(text: string): string[] {
	const results: string[] = []
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "{") continue
		let depth = 0
		let inString = false
		let escaped = false
		for (let j = i; j < text.length; j++) {
			const ch = text[j]!
			if (inString) {
				if (escaped) escaped = false
				else if (ch === "\\") escaped = true
				else if (ch === '"') inString = false
				continue
			}
			if (ch === '"') {
				inString = true
				continue
			}
			if (ch === "{") depth++
			else if (ch === "}") {
				depth--
				if (depth === 0) {
					results.push(text.slice(i, j + 1))
					break
				}
			}
		}
	}
	return results
}

function collectJsonCandidates(text: string): string[] {
	const trimmed = text.trim()
	const candidates: string[] = []
	const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
	for (const match of fenced) {
		const inner = match[1]?.trim()
		if (inner) candidates.push(inner)
	}
	candidates.push(...findBalancedJsonObjects(trimmed))
	if (candidates.length === 0) {
		const start = trimmed.indexOf("{")
		const end = trimmed.lastIndexOf("}")
		if (start !== -1 && end > start) {
			candidates.push(trimmed.slice(start, end + 1))
		}
	}
	return [...new Set(candidates)]
}

function extractReason(text: string): string | undefined {
	return (
		text.match(/["']reason["']\s*:\s*"([^"]*)"/i)?.[1] ??
		text.match(/\breason\s*:\s*"([^"]*)"/i)?.[1]
	)?.trim()
}

function regexVerdictFallback(text: string): ClassifierVerdict | null {
	const shouldBlock = text.match(
		/["']?shouldBlock["']?\s*[:=]\s*(true|false)/i,
	)
	if (shouldBlock) {
		const block = shouldBlock[1]!.toLowerCase() === "true"
		const reason = extractReason(text)
		return {
			allow: !block,
			reason: reason || (block ? "Classifier blocked" : "Classifier approved"),
		}
	}
	const allow = text.match(/["']?allow["']?\s*[:=]\s*(true|false)/i)
	if (allow) {
		const allowed = allow[1]!.toLowerCase() === "true"
		const reason = extractReason(text)
		return {
			allow: allowed,
			reason:
				reason ||
				(allowed ? "Classifier approved" : "Classifier denied"),
		}
	}
	return null
}

export function parseClassifierVerdict(text: string): ClassifierVerdict | null {
	const trimmed = text.trim()
	if (!trimmed) return null

	for (const candidate of collectJsonCandidates(trimmed)) {
		for (const variant of [candidate, repairJsonCandidate(candidate)]) {
			try {
				const parsed = JSON.parse(variant) as Record<string, unknown>
				const verdict = verdictFromParsedObject(parsed)
				if (verdict) return verdict
			} catch {
				// try next candidate
			}
		}
	}

	return regexVerdictFallback(trimmed)
}

function extractToolClassifierVerdict(
	message: AssistantMessage,
): ClassifierVerdict | null {
	for (const block of message.content) {
		if (
			block.type === "toolCall" &&
			block.name === CLASSIFIER_TOOL_NAME
		) {
			return verdictFromParsedObject(
				block.arguments as Record<string, unknown>,
			)
		}
	}
	return null
}

function extractClassifierResponseText(
	content: Array<{ type: string; text?: string; thinking?: string }>,
): string {
	const parts: string[] = []
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			parts.push(part.text)
		}
		if (
			part.type === "thinking" &&
			typeof part.thinking === "string" &&
			part.thinking.trim()
		) {
			parts.push(part.thinking)
		}
	}
	return parts.join("\n")
}

function buildClassifierCompletionOptions(
	model: Model<Api>,
	stage: ClassifierStage,
	base: {
		apiKey?: string
		headers?: Record<string, string>
		env?: Record<string, string>
		signal: AbortSignal
		maxTokens: number
	},
): Record<string, unknown> {
	const options: Record<string, unknown> = {
		...base,
		temperature: 0,
	}

	if (stage !== "tool") return options

	// CC auto-mode: no API extended thinking; force classify_result tool.
	if (model.api === "anthropic-messages") {
		options.thinkingEnabled = false
		options.toolChoice = { type: "tool", name: CLASSIFIER_TOOL_NAME }
	} else if (model.api === "openai-completions") {
		options.toolChoice = {
			type: "function",
			function: { name: CLASSIFIER_TOOL_NAME },
		}
	} else if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses"
	) {
		options.toolChoice = { type: "function", name: CLASSIFIER_TOOL_NAME }
	} else if (model.api === "bedrock-converse-stream") {
		options.toolChoice = { type: "tool", name: CLASSIFIER_TOOL_NAME }
	} else if (model.api === "mistral-conversations") {
		options.toolChoice = {
			type: "function",
			function: { name: CLASSIFIER_TOOL_NAME },
		}
	}

	return options
}

async function runClassifierCompletion(
	model: Model<Api>,
	auth: Extract<ResolvedAuth, { ok: true }>,
	systemPrompt: string,
	userPrompt: string,
	signal: AbortSignal,
	timeoutMs: number,
	abortMeta: { timedOut: boolean; parentSignal?: AbortSignal },
	stage: ClassifierStage,
	opts?: { maxTokens?: number; userSuffix?: string },
): Promise<AssistantMessage> {
	const context: Context = {
		systemPrompt,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: opts?.userSuffix
							? `${userPrompt}${opts.userSuffix}`
							: userPrompt,
					},
				],
				timestamp: Date.now(),
			},
		],
		...(stage === "tool" ? { tools: [classifierResultTool] } : {}),
	}

	const response = await completeSimple(
		model,
		context,
		buildClassifierCompletionOptions(model, stage, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			signal,
			maxTokens: opts?.maxTokens ?? (stage === "tool" ? 1024 : 512),
		}) as Parameters<typeof completeSimple>[2],
	)

	if (response.stopReason === "aborted") {
		if (abortMeta.timedOut) {
			throw new Error(`Classifier timed out after ${timeoutMs}ms`)
		}
		if (abortMeta.parentSignal?.aborted) {
			throw new Error("Classifier request cancelled")
		}
		throw new Error("Classifier request aborted")
	}
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Classifier request failed")
	}

	return response
}

function parseClassifierResponse(
	text: string,
	stage: ClassifierStage,
): ClassifierVerdict | null {
	if (stage === "single") {
		return parseClassifierVerdict(text)
	}
	const xmlVerdict = parseXmlClassifierVerdict(text)
	if (xmlVerdict) return xmlVerdict
	return parseClassifierVerdict(text)
}

async function classifyWithStagePipeline(opts: {
	model: Model<Api>
	auth: Extract<ResolvedAuth, { ok: true }>
	systemPrompt: string
	userPrompt: string
	signal: AbortSignal
	timeoutMs: number
	abortMeta: { timedOut: boolean; parentSignal?: AbortSignal }
	stage: ClassifierStage
	debug?: boolean
}): Promise<ClassifierVerdict> {
	const { stage } = opts

	if (stage === "tool") {
		const message = await runClassifierCompletion(
			opts.model,
			opts.auth,
			opts.systemPrompt,
			opts.userPrompt,
			opts.signal,
			opts.timeoutMs,
			opts.abortMeta,
			"tool",
		)
		const verdict = extractToolClassifierVerdict(message)
		if (!verdict) {
			const text = extractClassifierResponseText(message.content)
			if (opts.debug && text) {
				console.debug(
					"[permission-modes] Classifier tool-stage raw text:",
					text.slice(0, 2000),
				)
			}
			throw new Error("Classifier returned unparseable tool result")
		}
		return verdict
	}

	if (stage === "single") {
		const message = await runClassifierCompletion(
			opts.model,
			opts.auth,
			opts.systemPrompt,
			opts.userPrompt,
			opts.signal,
			opts.timeoutMs,
			opts.abortMeta,
			"single",
		)
		const text = extractClassifierResponseText(message.content)
		const verdict = parseClassifierResponse(text, "single")
		if (!verdict) throw new Error("Classifier returned unparseable JSON")
		return verdict
	}

	const xmlSystemPrompt = replaceOutputFormatWithXml(opts.systemPrompt)
	const wrappedUserPrompt = `<transcript>\n${opts.userPrompt}\n</transcript>\n`

	const runXmlStage = async (
		maxTokens: number,
		suffix: string,
	): Promise<ClassifierVerdict> => {
		const message = await runClassifierCompletion(
			opts.model,
			opts.auth,
			xmlSystemPrompt,
			wrappedUserPrompt,
			opts.signal,
			opts.timeoutMs,
			opts.abortMeta,
			stage,
			{ maxTokens, userSuffix: suffix },
		)
		const text = extractClassifierResponseText(message.content)
		const verdict = parseClassifierResponse(text, stage)
		if (!verdict) {
			if (opts.debug) {
				console.debug(
					"[permission-modes] Classifier XML raw:",
					text.slice(0, 2000),
				)
			}
			throw new Error("Classifier returned unparseable XML/JSON")
		}
		return verdict
	}

	if (stage === "thinking") {
		return runXmlStage(512, "")
	}

	// fast or both: stage 1
	const stage1 = await runXmlStage(
		stage === "fast" ? 256 : 64,
		XML_S1_SUFFIX,
	)
	if (stage1.allow || stage === "fast") {
		return stage1
	}

	// both: stage 2 CoT review on block
	return runXmlStage(512, "\nRe-evaluate carefully before your final <block>.")
}

// Short-TTL verdict memo for identical retries (plan A5): an unchanged
// denied/approved call re-classifies for free. Guardrails: wholesale
// invalidation when permission rules reload (verdicts depend on autoMode
// rules), a 60s TTL so a new turn's transcript is never served stale, and
// a 64-entry bound.
const verdictCache = new Map<string, { verdict: ClassifierVerdict; at: number }>()
const VERDICT_CACHE_TTL_MS = 60_000
const VERDICT_CACHE_MAX = 64
let verdictCacheVersion = 0

/** Drop all memoized verdicts (called when permission rules reload). */
export function invalidateClassifierVerdictCache(): void {
	verdictCacheVersion++
	verdictCache.clear()
}

function verdictCacheKey(opts: {
	modelRef: string
	session: ClassifierSessionContext
	pendingTool: { name: string; input: unknown }
	autoMode?: AutoModeRules
	stage?: ClassifierStage
}): string {
	return [
		verdictCacheVersion,
		opts.modelRef,
		opts.stage ?? "",
		opts.session.mode,
		opts.session.cwd,
		opts.autoMode ? JSON.stringify(opts.autoMode) : "",
		opts.pendingTool.name,
		JSON.stringify(opts.pendingTool.input ?? {}),
	].join("\u0000")
}

export async function classifyToolCall(opts: {
	modelRef: string
	session: ClassifierSessionContext
	pendingTool: { name: string; input: unknown }
	registry: ClassifierRegistry
	autoMode?: AutoModeRules
	signal?: AbortSignal
	timeoutMs: number
	jsonlTranscript?: boolean
	stage?: ClassifierStage
	includeAgentsMd?: boolean
	debug?: boolean
}): Promise<ClassifierVerdict> {
	const encoded = toClassifierInput(
		opts.pendingTool.name,
		(opts.pendingTool.input ?? {}) as Record<string, unknown>,
	)
	if (encoded === "") {
		return {
			allow: true,
			reason: "Tool declares no classifier-relevant input",
		}
	}

	const cacheKey = verdictCacheKey(opts)
	const cached = verdictCache.get(cacheKey)
	if (cached && Date.now() - cached.at < VERDICT_CACHE_TTL_MS) {
		return cached.verdict
	}

	const parsed = parseClassifierModelRef(opts.modelRef)
	if (!parsed) throw new Error(`Invalid classifier model ref: ${opts.modelRef}`)

	const stage = resolveClassifierStage(opts.modelRef, opts.stage)

	const model = opts.registry.find(parsed.provider, parsed.modelId)
	if (!model) throw new Error(`Classifier model not found: ${opts.modelRef}`)

	const controller = new AbortController()
	const abortMeta = { timedOut: false, parentSignal: opts.signal }
	const timeout = setTimeout(() => {
		abortMeta.timedOut = true
		controller.abort()
	}, opts.timeoutMs)
	let parentAbortHandler: (() => void) | undefined
	if (opts.signal && !opts.signal.aborted) {
		parentAbortHandler = () => controller.abort()
		opts.signal.addEventListener("abort", parentAbortHandler, { once: true })
	}

	try {
		const auth = await opts.registry.getApiKeyAndHeaders(model)
		if (!auth.ok) throw new Error(auth.error)

		const systemPrompt = buildClassifierSystemPrompt(opts.autoMode)
		const sessionForPrompt: ClassifierSessionContext = {
			...opts.session,
			agentsMd:
				opts.includeAgentsMd === false ? null : opts.session.agentsMd,
		}
		const userPrompt = buildClassifierUserPrompt({
			session: sessionForPrompt,
			pendingTool: opts.pendingTool,
			jsonlTranscript: opts.jsonlTranscript,
			stage,
		})

		if (opts.debug) {
			console.debug(
				"[permission-modes] Classifier request:",
				JSON.stringify({
					model: opts.modelRef,
					tool: opts.pendingTool.name,
					stage,
					systemChars: systemPrompt.length,
					userChars: userPrompt.length,
				}),
			)
		}

		const verdict = await classifyWithStagePipeline({
			model,
			auth,
			systemPrompt,
			userPrompt,
			signal: controller.signal,
			timeoutMs: opts.timeoutMs,
			abortMeta,
			stage,
			debug: opts.debug,
		})

		if (opts.debug) {
			console.debug(
				"[permission-modes] Classifier verdict:",
				JSON.stringify(verdict),
			)
		}
		if (verdictCache.size >= VERDICT_CACHE_MAX) {
			// Map preserves insertion order: drop the oldest entry.
			verdictCache.delete(verdictCache.keys().next().value as string)
		}
		verdictCache.set(cacheKey, { verdict, at: Date.now() })
		return verdict
	} finally {
		clearTimeout(timeout)
		if (parentAbortHandler && opts.signal) {
			opts.signal.removeEventListener("abort", parentAbortHandler)
		}
	}
}

export type { TranscriptEntry }
