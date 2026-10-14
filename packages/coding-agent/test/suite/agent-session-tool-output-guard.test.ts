import { existsSync, readFileSync, rmSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES } from "../../src/core/tools/truncate.ts";
import { createHarness, type Harness } from "./harness.ts";

function lines(count: number, render: (i: number) => string): string {
	return Array.from({ length: count }, (_, i) => render(i + 1)).join("\n");
}

function textTool(name: string, text: string): AgentTool {
	return {
		name,
		label: name,
		description: `Return ${name} output`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text }], details: { source: name } }),
	};
}

function lastToolResult(harness: Harness): ToolResultMessage {
	const message = harness.session.messages.filter((m) => m.role === "toolResult").at(-1);
	if (!message || message.role !== "toolResult") throw new Error("no tool result");
	return message;
}

describe("AgentSession tool output guard", () => {
	const harnesses: Harness[] = [];
	const files: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (files.length > 0) rmSync(files.pop()!, { force: true });
	});

	async function run(tool: AgentTool): Promise<ToolResultMessage> {
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run the tool");
		return lastToolResult(harness);
	}

	it("caps oversized extension tool output, keeps errors from the middle, and saves the full text", async () => {
		const text = lines(20_000, (i) => (i === 9_000 ? "ERROR: database connection refused" : `row ${i}`));
		const result = await run(textTool("dump", text));
		const output = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		const details = result.details as { source: string; outputGuard: { fullOutputPath: string; totalLines: number } };
		files.push(details.outputGuard.fullOutputPath);

		expect(Buffer.byteLength(output, "utf-8")).toBeLessThan(DEFAULT_MAX_BYTES + 1024);
		expect(output).toContain("row 1\n");
		expect(output).toContain("row 20000");
		expect(output).toContain("9000: ERROR: database connection refused");
		expect(output).toContain(`Full output: ${details.outputGuard.fullOutputPath}`);
		expect(details.source).toBe("dump");
		expect(details.outputGuard.totalLines).toBe(20_000);
		expect(existsSync(details.outputGuard.fullOutputPath)).toBe(true);
		expect(readFileSync(details.outputGuard.fullOutputPath, "utf-8")).toBe(text);
	});

	it("leaves output within the limit untouched", async () => {
		const text = lines(100, (i) => `row ${i}`);
		const result = await run(textTool("small", text));

		expect(result.content).toEqual([{ type: "text", text }]);
		expect(result.details).toEqual({ source: "small" });
	});
});
