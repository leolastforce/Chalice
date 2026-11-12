import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadHostPiCodingAgent } from "../../src/runs/shared/child-session.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

test("child sessions use the parent's explicit host root instead of the runner's enclosing package", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "chalice-child-host-"));
	const originalArgv1 = process.argv[1];
	const originalRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	try {
		const hostRoot = path.join(root, "packages", "coding-agent");
		const runner = path.join(root, "Chalice", "SubAgents", "runner.ts");
		mkdirSync(hostRoot, { recursive: true });
		mkdirSync(path.dirname(runner), { recursive: true });
		writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@leolastforce/chalice", type: "module" }));
		writeFileSync(path.join(hostRoot, "package.json"), JSON.stringify({
			name: "@leolastforce/chalice", type: "module", exports: { ".": "./sdk.js" },
		}));
		writeFileSync(path.join(hostRoot, "sdk.js"), 'export const hostMarker = "parent-host";');
		writeFileSync(runner, "");
		process.argv[1] = runner;

		await t.test("loads the supplied host even when the enclosing root has the same package name", async () => {
			process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = ` ${hostRoot} `;
			const sdk = await loadHostPiCodingAgent();
			assert.equal(Reflect.get(sdk, "hostMarker"), "parent-host");
		});

		await t.test("rejects an invalid explicit root instead of falling back to an inferred host", async () => {
			process.argv[1] = path.join(hostRoot, "sdk.js");
			process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = path.join(root, "missing-host");
			await assert.rejects(loadHostPiCodingAgent(), { code: "ENOENT" });
		});

		await t.test("rejects an explicit root with the wrong package identity", async () => {
			const wrongRoot = path.join(root, "wrong-host");
			mkdirSync(wrongRoot);
			writeFileSync(path.join(wrongRoot, "package.json"), JSON.stringify({ name: "unrelated-package" }));
			process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = wrongRoot;
			await assert.rejects(loadHostPiCodingAgent(), /refusing to load the host SDK/);
		});

		await t.test("still discovers the running host when no explicit root is supplied", async () => {
			delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
			const sdk = await loadHostPiCodingAgent();
			assert.equal(Reflect.get(sdk, "hostMarker"), "parent-host");
		});
	} finally {
		if (originalArgv1 === undefined) delete process.argv[1];
		else process.argv[1] = originalArgv1;
		if (originalRoot === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = originalRoot;
		rmSync(root, { recursive: true, force: true });
	}
});
