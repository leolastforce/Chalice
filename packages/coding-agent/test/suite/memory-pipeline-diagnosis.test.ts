import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
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

// Request-local memory must survive replacement prompts from other extensions.
it.each(["structured", "replacement", "test-methods", "combined"] as const)(
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
					if (mode === "replacement" || mode === "combined") {
						// Same return shape as PermissionModes, without starting its sandbox.
						pi.on("before_agent_start", (event) => ({
							systemPrompt: `${event.systemPrompt}\nReplacement prompt marker`,
						}));
					}
				},
				...(mode === "test-methods" || mode === "combined" ? [testMethodsExtension] : []),
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
		const store = new MemoryStore(dir, harness.tempDir);
		const memory = store.save("Diagnostic memory marker", "global");
		const toolNames: string[][] = [];
		harness.setResponses(
			Array.from({ length: 3 }, () => (context) => {
				providerPrompts.push(getCurrentSystemPrompt(context.messages));
				toolNames.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage("done");
			}),
		);
		await harness.session.prompt("Answer without using tools");

		store.save("Updated memory marker", "global", memory.id);
		await harness.session.prompt("Continue without using tools");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ chaliceMemorySaving: false }));
		await harness.session.prompt("Continue with memory disabled");

		expect(hookPrompts).toHaveLength(3);
		expect(providerPrompts).toHaveLength(3);
		expect(hookPrompts[0]).toContain("Diagnostic memory marker");
		expect(providerPrompts[0]).toContain("Diagnostic memory marker");
		expect(providerPrompts[1]).toContain("Updated memory marker");
		expect(providerPrompts[1]).not.toContain("Diagnostic memory marker");
		expect(providerPrompts[2]).not.toContain("Updated memory marker");
		expect(JSON.stringify(harness.session.messages)).not.toContain("memory marker");
		for (const [index, prompt] of providerPrompts.entries()) {
			expect(prompt).toContain("Username: Diagnostic User");
			expect(toolNames[index]).toEqual(harness.session.getActiveToolNames());
			if (mode === "replacement" || mode === "combined") {
				expect(prompt).toContain("Replacement prompt marker");
				expect(hookPrompts[index]).toContain("Replacement prompt marker");
			}
			if (mode === "test-methods" || mode === "combined") {
				expect(prompt).toContain("Diagnostic test-method marker");
				expect(hookPrompts[index]).toContain("Diagnostic test-method marker");
			}
		}
	},
);
