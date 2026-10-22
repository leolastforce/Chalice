/**
 * MCP server configuration and the servers extensions register with `pi.registerMcpServer()`.
 *
 * The core only validates and stores registrations. The MCP adapter extension may consume them.
 */

export type McpExposure = "codemode" | "codemode-deferred" | "deferred" | "direct" | "hidden";

const MCP_EXPOSURES: readonly string[] = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"];

interface McpServerConfigBase {
	exposure?: McpExposure;
	toolExposure?: Record<string, McpExposure>;
	enabled?: boolean;
	timeout?: number;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpOAuthConfig {
	clientId?: string;
	clientSecret?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http";
	url: string;
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isExposure(value: unknown): value is McpExposure {
	return typeof value === "string" && MCP_EXPOSURES.includes(value);
}

function validateOAuth(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "oauth must be an object";
	if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string")
		return "oauth.clientSecret must be a string";
	if (
		value.callbackPort !== undefined &&
		(typeof value.callbackPort !== "number" ||
			!Number.isInteger(value.callbackPort) ||
			value.callbackPort < 1 ||
			value.callbackPort > 65535)
	) {
		return "oauth.callbackPort must be a port number";
	}
	if (value.callbackUrl !== undefined) {
		if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl)) {
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		}
	}
	if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
	return undefined;
}

export function isLoopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === "";
}

function toolPatternRegExp(pattern: string): RegExp {
	return new RegExp(
		`^${pattern
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\\]\\]/g, "\\$&"))
			.join(".*")}$`,
	);
}

export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	const overrides = config.toolExposure ?? {};
	if (overrides[toolName] !== undefined) return overrides[toolName];
	for (const [pattern, exposure] of Object.entries(overrides)) {
		if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
	}
	return config.exposure ?? "codemode";
}

export function validateMcpServerConfig(name: string, value: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(value)) return `server "${name}" must be an object`;
	const { type, exposure, enabled, timeout, toolExposure } = value;
	if (exposure !== undefined && !isExposure(exposure)) return `server "${name}": invalid exposure`;
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const exposureValue of Object.values(toolExposure)) {
			if (!isExposure(exposureValue)) return `server "${name}": invalid tool exposure`;
		}
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0)))
		return `server "${name}": timeout must be positive`;
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported`;
	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol))
			return `server "${name}": url must be http or https`;
		if (value.headers !== undefined && !isStringRecord(value.headers))
			return `server "${name}": headers must map names to strings`;
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		return value as unknown as McpHttpServerConfig;
	}
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (
			value.args !== undefined &&
			!(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
		)
			return `server "${name}": args must be an array of strings`;
		if (value.env !== undefined && !isStringRecord(value.env))
			return `server "${name}": env must map names to strings`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		return value as unknown as McpStdioServerConfig;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

export interface RegisteredMcpServer {
	name: string;
	config: McpServerConfig;
	extensionPath: string;
}

export class McpServerRegistry {
	private readonly servers = new Map<string, RegisteredMcpServer>();
	private changeListener: (() => void) | undefined;

	register(server: RegisteredMcpServer): void {
		this.servers.set(server.name, server);
		this.changeListener?.();
	}

	unregister(name: string, extensionPath: string): void {
		if (this.servers.get(name)?.extensionPath !== extensionPath) return;
		this.servers.delete(name);
		this.changeListener?.();
	}

	get(name: string): RegisteredMcpServer | undefined {
		return this.servers.get(name);
	}

	list(): RegisteredMcpServer[] {
		return [...this.servers.values()].map((server) => ({ ...server, config: structuredClone(server.config) }));
	}

	setChangeListener(listener: (() => void) | undefined): void {
		this.changeListener = listener;
	}
}
