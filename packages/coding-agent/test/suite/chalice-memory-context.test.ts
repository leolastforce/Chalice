import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import memoryExtension from "../../../../Chalice/Memory/index.ts";
import { MemoryStore } from "../../../../Chalice/Memory/store.ts";
import { createHarness, type Harness } from "./harness.ts";

const originalDir = process.env.CHALICE_CODING_AGENT_DIR;
const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (originalDir === undefined) delete process.env.CHALICE_CODING_AGENT_DIR;
	else process.env.CHALICE_CODING_AGENT_DIR = originalDir;
});

it("pushes scoped memories and guidance into actual provider requests without persisting them", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-provider-"));
	dirs.push(dir);
	process.env.CHALICE_CODING_AGENT_DIR = dir;
	const harness = await createHarness({ extensionFactories: [memoryExtension], tools: [] });
	harnesses.push(harness);
	const store = new MemoryStore(dir, harness.tempDir);
	const saved = store.save("Leo prefers concise answers", "global");
	store.save("Remind Leo about the project milestone", "project");
	new MemoryStore(dir, join(dir, "other")).save("Other project's private fact", "project");
	harness.session.setActiveToolsByName([]);
	const prompts: string[] = [];
	harness.setResponses([
		(context) => {
			prompts.push(getCurrentSystemPrompt(context.messages));
			return fauxAssistantMessage("done");
		},
		(context) => {
			prompts.push(getCurrentSystemPrompt(context.messages));
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("Hello");
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ chaliceMemorySaving: false }));
	await harness.session.prompt("Continue");
	expect(prompts[0]).toContain("Leo prefers concise answers");
	expect(prompts[0]).not.toContain(saved.id);
	expect(prompts[0]).toContain("Remind Leo about the project milestone");
	expect(prompts[0]).toContain("do not claim you have no personal context");
	expect(prompts[0]).toContain("rather than assuming the current working directory");
	expect(prompts[0]).not.toContain("Other project's private fact");
	expect(prompts[1]).not.toContain("Leo prefers concise answers");
	expect(JSON.stringify(harness.session.messages)).not.toContain("Leo prefers concise answers");
});
