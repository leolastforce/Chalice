import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmWorkspace } from "../../../../Chalice/PermissionModes/src/workspace.ts";

const temporaryDirectories: string[] = [];

function createProject(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-confirm-workspace-test-"));
	temporaryDirectories.push(directory);
	mkdirSync(join(directory, "src"), { recursive: true });
	mkdirSync(join(directory, "node_modules", "sample"), { recursive: true });
	writeFileSync(join(directory, "src", "note.txt"), "before\n");
	writeFileSync(join(directory, "node_modules", "sample", "existing.txt"), "installed before\n");
	writeFileSync(join(directory, ".gitignore"), "node_modules/\n");
	return directory;
}

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
	}
});

describe("ConfirmWorkspace", () => {
	it("stages shell-process edits, ignored files, additions, and deletions until approval", async () => {
		const project = createProject();
		const workspace = await ConfirmWorkspace.create(project);
		try {
			if (process.platform === "win32") {
				execFileSync(
					process.execPath,
					[
						"-e",
						"const fs=require('node:fs'); fs.writeFileSync('src/note.txt','after\\n'); fs.writeFileSync('src/new.txt','created\\n'); fs.unlinkSync('node_modules/sample/existing.txt'); fs.writeFileSync('node_modules/sample/installed.txt','installed\\n')",
					],
					{ cwd: workspace.workingDirectory },
				);
			} else {
				execFileSync(
					"bash",
					[
						"-c",
						"printf '%s\\n' after > src/note.txt; printf '%s\\n' created > src/new.txt; rm node_modules/sample/existing.txt; printf '%s\\n' installed > node_modules/sample/installed.txt",
					],
					{ cwd: workspace.workingDirectory },
				);
			}

			expect(readFileSync(join(project, "src", "note.txt"), "utf8")).toBe("before\n");
			expect(existsSync(join(project, "src", "new.txt"))).toBe(false);
			expect(existsSync(join(project, "node_modules", "sample", "existing.txt"))).toBe(true);

			const review = await workspace.review();
			expect(review.conflicts).toEqual([]);
			expect(review.changes.map(({ path, change }) => `${change}:${path}`).sort()).toEqual([
				"added:node_modules/sample/installed.txt",
				"added:src/new.txt",
				"deleted:node_modules/sample/existing.txt",
				"modified:src/note.txt",
			]);
			expect(review.diff).toContain("src/note.txt");
			expect(review.diff).toContain("after");

			const result = await workspace.apply();
			expect(result.conflicts).toEqual([]);
			expect(readFileSync(join(project, "src", "note.txt"), "utf8")).toBe("after\n");
			expect(readFileSync(join(project, "src", "new.txt"), "utf8")).toBe("created\n");
			expect(existsSync(join(project, "node_modules", "sample", "existing.txt"))).toBe(false);
			expect(readFileSync(join(project, "node_modules", "sample", "installed.txt"), "utf8")).toBe("installed\n");
		} finally {
			await workspace.discard();
		}
	});

	it("discards staged edits without changing the original workspace", async () => {
		const project = createProject();
		const workspace = await ConfirmWorkspace.create(project);
		writeFileSync(join(workspace.workingDirectory, "src", "note.txt"), "denied\n");
		await workspace.discard();

		expect(readFileSync(join(project, "src", "note.txt"), "utf8")).toBe("before\n");
	});

	it("refuses approval when the original workspace changes concurrently", async () => {
		const project = createProject();
		const workspace = await ConfirmWorkspace.create(project);
		try {
			writeFileSync(join(workspace.workingDirectory, "src", "note.txt"), "agent result\n");
			writeFileSync(join(project, "src", "note.txt"), "user edit\n");

			const review = await workspace.review();
			expect(review.conflicts).toContain("src/note.txt");

			const result = await workspace.apply();
			expect(result.applied).toEqual([]);
			expect(result.conflicts).toContain("src/note.txt");
			expect(readFileSync(join(project, "src", "note.txt"), "utf8")).toBe("user edit\n");
		} finally {
			await workspace.discard();
		}
	});

	it.skipIf(process.platform === "win32")("keeps absolute in-workspace symlinks inside the staged copy", async () => {
		const project = createProject();
		symlinkSync(join(project, "src", "note.txt"), join(project, "absolute-link.txt"));
		const workspace = await ConfirmWorkspace.create(project);
		try {
			expect(readlinkSync(join(workspace.workingDirectory, "absolute-link.txt"))).toBe("src/note.txt");
			execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync('absolute-link.txt','staged\\n')"], {
				cwd: workspace.workingDirectory,
			});
			expect(readFileSync(join(workspace.workingDirectory, "src", "note.txt"), "utf8")).toBe("staged\n");
			expect(readFileSync(join(project, "src", "note.txt"), "utf8")).toBe("before\n");
			expect(readFileSync(join(project, "absolute-link.txt"), "utf8")).toBe("before\n");
			const review = await workspace.review();
			expect(review.changes.map((change) => change.path)).toEqual(["src/note.txt"]);
			await workspace.apply();
			expect(readFileSync(join(project, "src", "note.txt"), "utf8")).toBe("staged\n");
			expect(readFileSync(join(project, "absolute-link.txt"), "utf8")).toBe("staged\n");
		} finally {
			await workspace.discard();
		}
	});

	it("gives the staged shell a private Git index", async () => {
		const project = createProject();
		execFileSync("git", ["init", "--quiet"], { cwd: project });
		const originalStatus = execFileSync("git", ["status", "--short"], { cwd: project, encoding: "utf8" });
		const workspace = await ConfirmWorkspace.create(project);
		try {
			execFileSync("git", ["add", "src/note.txt"], { cwd: workspace.workingDirectory });
			const stagedStatus = execFileSync("git", ["status", "--short"], {
				cwd: workspace.workingDirectory,
				encoding: "utf8",
			});
			expect(stagedStatus).toContain("A  src/note.txt");
			expect(execFileSync("git", ["status", "--short"], { cwd: project, encoding: "utf8" })).toBe(originalStatus);
			expect(existsSync(join(workspace.workingDirectory, ".git", "index"))).toBe(true);
		} finally {
			await workspace.discard();
		}
	});
});
