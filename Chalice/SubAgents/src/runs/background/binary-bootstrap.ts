import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti, type Jiti } from "jiti";
import { getAgentDir, isPiCodingAgentPackageName, PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import { resolveHostPeerAliases, resolvePackageSubpath } from "./runner-aliases.ts";
import type { DefaultChildSessionFactoryOptions, PiCodingAgentModule } from "../shared/child-session.ts";
import type { SubagentRunConfig } from "./subagent-runner.ts";
import { installRunnerHttpDispatcher } from "./runner-http-dispatcher.ts";
import { runConfiguredSubagent, validateSubagentRunConfig } from "./subagent-runner-bootstrap.ts";
type SubagentExecutionModule = {
	runConfiguredSubagentExecution(config: SubagentRunConfig, options?: DefaultChildSessionFactoryOptions): Promise<void>;
};

function resolveHostSdkPackage(): { root: string; entry: string } {
	const roots = [
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV],
		process.env.PI_PACKAGE_DIR,
		resolvePiPackageRoot(),
		resolveInstalledPiPackageRoot(),
	];
	for (const rootValue of roots) {
		const root = rootValue?.trim();
		if (!root) continue;
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown };
			if (!isPiCodingAgentPackageName(manifest.name)) continue;
			const entry = resolvePackageSubpath(root, ".");
			if (entry && fs.existsSync(entry)) return { root, entry };
		} catch {
			// Ignore invalid package roots and try the next host discovery path.
		}
	}
	throw new Error("Could not resolve the installed Pi coding-agent package for the binary runner");
}

async function loadBinaryHostModules(): Promise<{ runnerJiti: Jiti; sdk: PiCodingAgentModule }> {
	const host = resolveHostSdkPackage();
	const { aliases, missing } = resolveHostPeerAliases(host.root);
	if (missing.length > 0) {
		throw new Error(`The installed Pi package at ${host.root} is missing runner peers: ${missing.join(", ")}`);
	}
	const dependencyJiti = createJiti(import.meta.url, {
		alias: aliases,
		tryNative: false,
		moduleCache: false,
	});
	const [piAi, typebox, typeboxCompile, typeboxValue, piCore, piTui] = await Promise.all([
		dependencyJiti.import("@earendil-works/pi-ai/compat"),
		dependencyJiti.import("typebox"),
		dependencyJiti.import("typebox/compile"),
		dependencyJiti.import("typebox/value"),
		dependencyJiti.import("@earendil-works/pi-agent-core"),
		dependencyJiti.import("@earendil-works/pi-tui"),
	]);
	const virtualModules: Record<string, unknown> = {
		"@earendil-works/pi-ai": piAi,
		"@earendil-works/pi-ai/compat": piAi,
		"@earendil-works/pi-agent-core": piCore,
		"@earendil-works/pi-tui": piTui,
		typebox,
		"typebox/compile": typeboxCompile,
		"typebox/value": typeboxValue,
	};
	const sdkJiti = createJiti(import.meta.url, { tryNative: false, moduleCache: false, virtualModules });
	const sdk = await sdkJiti.import<PiCodingAgentModule>(host.entry);
	virtualModules["@earendil-works/pi-coding-agent"] = sdk;
	const runnerJiti = createJiti(import.meta.url, { tryNative: false, moduleCache: false, virtualModules });
	return { runnerJiti, sdk };
}

/**
 * Pi's extension loader supplies the embedded SDK. Bare Bun/Node cannot replace
 * it: an apparent import success can be an auto-installed, different SDK.
 * Await the configured runner inside extension initialization so the outer Pi
 * session/RPC loop never starts. Exit only after shared disposal/lease release.
 * Derived from xz-dev's PR #2049, commit 910807bfefcf9ee41d73fa25ec86dcd75ab8f4b2.
 */
export default async function runBinaryBootstrap(): Promise<never> {
	const configPath = process.env.PI_SUBAGENT_RUNNER_CONFIG;
	delete process.env.PI_SUBAGENT_RUNNER_CONFIG;
	try {
		if (!configPath || !path.isAbsolute(configPath)) throw new Error("Missing absolute PI_SUBAGENT_RUNNER_CONFIG path");
		const rawConfig: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
		validateSubagentRunConfig(rawConfig);
		const config = rawConfig;
		try {
			fs.unlinkSync(configPath);
		} catch {
			// Temp-config cleanup is best effort, as in the Node entrypoint.
		}
		// Pi applies httpIdleTimeoutMs to its dispatcher only after extension
		// factories return; this factory never does, so install the runner's own.
		installRunnerHttpDispatcher({ agentDir: getAgentDir(), cwd: process.cwd() });
		const hostModules = await loadBinaryHostModules();
		await runConfiguredSubagent(config, {
			loadPiCodingAgent: async () => hostModules.sdk,
			loadExecutionModule: async () => {
				const runner = `./subagent-runner${path.extname(fileURLToPath(import.meta.url))}`;
				return hostModules.runnerJiti.import<SubagentExecutionModule>(runner);
			},
		});
		process.exit(0);
	} catch (error) {
		console.error("Subagent binary runner error:", error);
		process.exit(1);
	}
}
