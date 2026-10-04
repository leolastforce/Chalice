import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import todoExtension from "../../../../Chalice/Todo/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("Todo agent guidance", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("prompts agents to show a plan and keep progress accurate across requests", async () => {
		const prompts: string[] = [];
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				todoExtension,
				(pi) => {
					pi.on("before_agent_start", (event) => {
						prompts.push(event.systemPrompt);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);

		await harness.session.prompt("Investigate and fix the issue");
		await harness.session.prompt("Continue the investigation");

		expect(prompts).toHaveLength(2);
		for (const prompt of prompts) {
			expect(prompt).toContain("user-visible TODO list");
			expect(prompt).toContain("before starting substantial work");
			expect(prompt).toContain("skip it for quick answers or trivial one-step tasks");
			expect(prompt).toContain("toggle each item as soon as it is completed");
			expect(prompt).toContain("including any required verification");
			expect(prompt).toContain("check existing items and their IDs");
			expect(prompt).toContain("Leave blocked or unfinished todo items open");
			expect(prompt).toContain("Do not use todo clear to hide unfinished work");
			expect(prompt.split("Use todo proactively")).toHaveLength(2);
		}
	});

	it("includes TODO guidance only while the todo tool is active", async () => {
		const prompts: string[] = [];
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				todoExtension,
				(pi) => {
					pi.on("before_agent_start", (event) => {
						prompts.push(event.systemPrompt);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);

		harness.session.setActiveToolsByName([]);
		await harness.session.prompt("Answer a question without tools");
		harness.session.setActiveToolsByName(["todo"]);
		await harness.session.prompt("Plan the next task");

		expect(prompts[0]).not.toContain("Use todo proactively");
		expect(prompts[0]).not.toContain("user-visible TODO list");
		expect(prompts[1]).toContain("Use todo proactively");
		expect(prompts[1]).toContain("user-visible TODO list");
	});
});
