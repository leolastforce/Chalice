import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	loadMergedPermissionRules,
	writeProjectPermissionsFile,
	writeGlobalPermissionsConfig,
} from "./permissions-loader.ts"
import { setConfigPath } from "./config.ts"

describe("permissions-loader", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-perm-"))
		setConfigPath(join(tmpDir, "permission-modes.json"))
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("merges global and project rules", () => {
		writeGlobalPermissionsConfig({
			allow: ["Bash(npm run:*)"],
		})
		writeProjectPermissionsFile(tmpDir, {
			deny: ["Bash(rm *)"],
		})
		const rules = loadMergedPermissionRules(tmpDir)
		expect(rules.some((r) => r.behavior === "allow")).toBe(true)
		expect(rules.some((r) => r.behavior === "deny")).toBe(true)
	})
})
