import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolveHostPeerAliases } from "../../src/runs/background/runner-aliases.ts";

import { createJiti } from "jiti";

test("runner aliases workspace peers in native Node and Jiti loaders instead of stale nested copies", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-subagents-runner-aliases-"));
	try {
		const hostRoot = path.join(root, "packages", "coding-agent");
		const agentRoot = path.join(root, "packages", "agent");
		const staleHostPackage = path.join(hostRoot, "node_modules", "@earendil-works", "pi-ai");
		const staleAgentPackage = path.join(agentRoot, "node_modules", "@earendil-works", "pi-ai");
		const workspacePackage = path.join(root, "packages", "ai");
		const workspaceLink = path.join(root, "node_modules", "@earendil-works", "pi-ai");
		const workspaceEntry = path.join(workspacePackage, "dist", "compat.js");
		const agentLoop = path.join(agentRoot, "dist", "agent-loop.mjs");
		mkdirSync(path.join(hostRoot, "dist"), { recursive: true });
		mkdirSync(path.join(agentRoot, "dist"), { recursive: true });
		mkdirSync(path.join(staleHostPackage, "dist"), { recursive: true });
		mkdirSync(path.join(staleAgentPackage, "dist"), { recursive: true });
		mkdirSync(path.dirname(workspaceLink), { recursive: true });
		mkdirSync(path.dirname(workspaceEntry), { recursive: true });
		writeFileSync(path.join(hostRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", exports: { ".": "./dist/index.js" } }));
		writeFileSync(path.join(hostRoot, "dist", "index.js"), "");
		for (const stalePackage of [staleHostPackage, staleAgentPackage]) {
			writeFileSync(path.join(stalePackage, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.85.1", exports: { "./compat": "./dist/compat.js" } }));
			writeFileSync(path.join(stalePackage, "dist", "compat.js"), "export const staleCopy = true;");
		}
		writeFileSync(path.join(workspacePackage, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.85.1", exports: { "./compat": "./dist/compat.js" } }));
		writeFileSync(workspaceEntry, "export const getCurrentTools = () => []; ");
		writeFileSync(agentLoop, 'import { getCurrentTools } from "@earendil-works/pi-ai"; if (typeof getCurrentTools !== "function") throw new Error("missing host export");');
		symlinkSync(workspacePackage, workspaceLink, "junction");

		const { aliases } = resolveHostPeerAliases(hostRoot);
		const preload = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runner-peer-preload.mjs");
		const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(agentLoop).href)})`], {
			encoding: "utf8",
			env: { ...process.env, JITI_ALIAS: JSON.stringify(aliases), PI_ASYNC_NATIVE_RUNNER: "1" },
		});

		assert.equal(result.status, 0, result.error?.message ?? result.stderr);
		const jiti = createJiti(import.meta.url, { alias: aliases, tryNative: false, moduleCache: false });
		await jiti.import(pathToFileURL(agentLoop).href);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
