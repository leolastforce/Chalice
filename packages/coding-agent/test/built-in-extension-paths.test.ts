import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBuiltInExtensionPaths } from "../src/config.ts";

const originalPackageDir = process.env.PI_PACKAGE_DIR;
const root = mkdtempSync(join(tmpdir(), "chalice-extension-paths-"));

afterEach(() => {
	if (originalPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
	else process.env.PI_PACKAGE_DIR = originalPackageDir;
	rmSync(root, { recursive: true, force: true });
});

describe("built-in extension paths", () => {
	it("prefers checkout extensions over stale packaged copies", () => {
		const packageDir = join(root, "packages", "coding-agent");
		mkdirSync(join(packageDir, "src"), { recursive: true });
		mkdirSync(join(packageDir, "dist", "Chalice"), { recursive: true });
		mkdirSync(join(root, "Chalice"), { recursive: true });
		process.env.PI_PACKAGE_DIR = packageDir;

		expect(getBuiltInExtensionPaths()).toContain(join(root, "Chalice", "PermissionModes", "src", "index.ts"));
	});

	it("uses packaged extensions for an installed package", () => {
		const packageDir = join(root, "node_modules", "chalice");
		mkdirSync(join(packageDir, "dist", "Chalice"), { recursive: true });
		process.env.PI_PACKAGE_DIR = packageDir;

		expect(getBuiltInExtensionPaths()).toContain(
			join(packageDir, "dist", "Chalice", "PermissionModes", "src", "index.ts"),
		);
	});
});
