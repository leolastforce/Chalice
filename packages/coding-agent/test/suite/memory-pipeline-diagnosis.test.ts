import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import memoryExtension from "../../../../Chalice/Memory/index.ts";
import { MemoryStore } from "../../../../Chalice/Memory/store.ts";
import testMethodsExtension from "../../../../Chalice/TestMethods/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
const originalDir = process.env.CHALICE_CODING_AGENT_DIR;
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	if (originalDir === undefined) delete process.env.CHALICE_CODING_AGENT_DIR;
	else process.env.CHALICE_CODING_AGENT_DIR = originalDir;
});

// Diagnostic characterization, not the desired contract: forced prompts currently erase memory.
// Once the pipeline is fixed, both forced cases should expect memory at the provider too.
it.each(["structured", "replacement", "test-methods"] as const)(
	"traces memory from the context hook to the provider with %s prompts",
	async (mode) => {
		const dir = mkdtempSync(join(tmpdir(), "memory-pipeline-"));
		directories.push(dir);
		process.env.CHALICE_CODING_AGENT_DIR = dir;
		const hookPrompts: string[] = [];
		const providerPrompts: string[] = [];
		const harness = await createHarness({
			tools: [],
			settings: { username: "Diagnostic User", usernameEnabled: true },
			extensionFactories: [
				(pi) => {
					if (mode === "replacement") {
						// Same return shape as PermissionModes, without starting its sandbox.
						pi.on("before_agent_start", (event) => ({
							systemPrompt: `${event.systemPrompt}\nReplacement prompt marker`,
						}));
					}
				},
				...(mode === "test-methods" ? [testMethodsExtension] : []),
				memoryExtension,
				(pi) => {
					pi.on("context_with_system", (event) => {
						hookPrompts.push(getCurrentSystemPrompt(event.messages));
					});
				},
			],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "TESTMETHODS.md"), "Diagnostic test-method marker");
		new MemoryStore(dir, harness.tempDir).save("Diagnostic memory marker", "global");
		harness.session.setActiveToolsByName([]);
		harness.setResponses([
			(context) => {
				providerPrompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Answer without using tools");

		expect(hookPrompts).toHaveLength(1);
		expect(providerPrompts).toHaveLength(1);
		expect(hookPrompts[0]).toContain("Diagnostic memory marker");
		expect(providerPrompts[0]).toContain("Username: Diagnostic User");
		expect(providerPrompts[0]?.includes("Diagnostic memory marker")).toBe(mode === "structured");
		if (mode === "replacement") expect(providerPrompts[0]).toContain("Replacement prompt marker");
		if (mode === "test-methods") expect(providerPrompts[0]).toContain("Diagnostic test-method marker");
	},
);
