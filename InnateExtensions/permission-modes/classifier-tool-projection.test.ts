import { describe, expect, it } from "vitest"
import { toClassifierInput } from "./classifier-tool-projection.ts"

describe("toClassifierInput", () => {
	it("projects bash to command string", () => {
		expect(toClassifierInput("bash", { command: "npm test" })).toBe("npm test")
	})

	it("projects read/grep paths", () => {
		expect(toClassifierInput("read", { path: "src/a.ts" })).toBe("src/a.ts")
		expect(toClassifierInput("grep", { pattern: "foo" })).toBe("foo")
	})

	it("returns empty for missing security-relevant fields", () => {
		expect(toClassifierInput("read", {})).toBe("")
	})

	it("projects write with path and preview", () => {
		const out = toClassifierInput("write", {
			path: "x.ts",
			content: "hello world",
		}) as { path: string; preview?: string }
		expect(out.path).toBe("x.ts")
		expect(out.preview).toBe("hello world")
	})
})
