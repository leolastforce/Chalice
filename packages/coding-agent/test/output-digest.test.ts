import { describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { digestText, NotableLineCollector } from "../src/core/tools/output-digest.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

describe("NotableLineCollector", () => {
	it("tracks line numbers across chunk boundaries and strips ANSI escapes", () => {
		const collector = new NotableLineCollector();
		collector.push("ok\nfirst ");
		collector.push("line\n\u001b[31mFAIL\u001b[0m src/a.test.ts\nTests: 3 passed, 1 fai");
		collector.push("led\n");
		collector.finish();

		expect(collector.inRange(1, 10)).toEqual([
			{ line: 3, text: "FAIL src/a.test.ts" },
			{ line: 4, text: "Tests: 3 passed, 1 failed" },
		]);
		expect(collector.total).toBe(2);
	});

	it("keeps the earliest and latest matches when there are too many", () => {
		const collector = new NotableLineCollector();
		for (let i = 1; i <= 500; i++) collector.push(`error ${i}\n`);
		collector.finish();

		const shown = collector.inRange(1, 500, 10).map((n) => n.line);
		expect(shown).toEqual([1, 2, 3, 4, 495, 496, 497, 498, 499, 500]);
		expect(collector.total).toBe(500);
	});
});

describe("digestText", () => {
	it("returns small text unchanged", () => {
		expect(digestText("a\nb").truncated).toBe(false);
	});

	it("keeps raw byte ranges for a single huge line", () => {
		const text = `{"data":"${"x".repeat(200_000)}"}`;
		const digest = digestText(text);

		expect(digest.truncated).toBe(true);
		expect(digest.content.startsWith('{"data":"xxx')).toBe(true);
		expect(digest.content.endsWith('xxx"}')).toBe(true);
		expect(digest.content).toContain("omitted] ...");
		expect(Buffer.byteLength(digest.content, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});
});

describe("OutputAccumulator digest", () => {
	it("shows head, notable middle lines, and tail for long shell output", () => {
		const output = new OutputAccumulator();
		output.append(Buffer.from("> vitest run\n"));
		for (let i = 2; i <= 10_000; i++) {
			output.append(Buffer.from(i === 4_321 ? "AssertionError: expected 1 to be 2\n" : `test ${i} ok\n`));
		}
		output.finish();

		const snapshot = output.snapshot({ digest: true });
		const digest = snapshot.digest;
		expect(digest).toBeDefined();
		expect(digest?.head.startsWith("> vitest run\ntest 2 ok")).toBe(true);
		expect(digest?.headLines).toBe(50);
		expect(digest?.notable).toEqual([{ line: 4_321, text: "AssertionError: expected 1 to be 2" }]);
		expect(digest?.tail.endsWith("test 10000 ok")).toBe(true);
		expect(snapshot.truncation.outputLines).toBeLessThanOrEqual(2000);
		expect(snapshot.content).toBe(digest?.tail);
	});

	it("does not build a digest without the option or when output fits", () => {
		const output = new OutputAccumulator();
		for (let i = 1; i <= 3000; i++) output.append(Buffer.from(`${i}\n`));
		output.finish();
		expect(output.snapshot().digest).toBeUndefined();

		const small = new OutputAccumulator();
		small.append(Buffer.from("error: tiny\n"));
		small.finish();
		expect(small.snapshot({ digest: true }).digest).toBeUndefined();
	});
});
