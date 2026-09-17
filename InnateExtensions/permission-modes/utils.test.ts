import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { readdirSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import {
	checkAutoRisk,
	commandReferencesSensitivePath,
	commandTargetsOutsideCwd,
	ensurePlanFile,
	extractPlanSection,
	extractTodoItems,
	filterSkillsFromPrompt,
	filterSubstantivePlanItems,
	findProjectRoot,
	formatCount,
	getPlanFilePath,
	getProjectId,
	getProjectTmpDir,
	hashPath,
	hashPlan,
	injectModePrompt,
	isAutoApprovableBash,
	classifyBashTiers,
	isAutoFallbackBash,
	isCompletionSignal,
	isInsideProject,
	isOutsideCwd,
	isSensitivePath,
	isPlanFilePath,
	isPlaceholderPlanItem,
	isSafeCommand,
	listTrackedOutsideWrites,
	markCompletedSteps,
	popTrackedOutsideWrite,
	readPlanFile,
	resolveModePrompt,
	restoreOutsideWrite,
	shouldSyncAssistantPlanToFile,
	trackOutsideWrite,
	writePlanFile,
	type OutsideWriteSnapshot,
	type TodoItem,
} from "./utils.ts";

describe("isSafeCommand", () => {
	it("approves commands matching SAFE_PATTERNS", () => {
		expect(isSafeCommand("ls -la")).toBe(true);
		expect(isSafeCommand("cat foo.txt")).toBe(true);
		expect(isSafeCommand("grep -r pattern src")).toBe(true);
		expect(isSafeCommand("git status")).toBe(true);
		expect(isSafeCommand("git log --oneline")).toBe(true);
		expect(isSafeCommand("npm list")).toBe(true);
		expect(isSafeCommand("curl https://example.com")).toBe(false);
		expect(isSafeCommand("wget -O - https://example.com")).toBe(false);
	});

	it("rejects destructive commands", () => {
		expect(isSafeCommand("rm -rf /")).toBe(false);
		expect(isSafeCommand("mv foo bar")).toBe(false);
		expect(isSafeCommand("npm install")).toBe(false);
		expect(isSafeCommand("git commit -m msg")).toBe(false);
		expect(isSafeCommand("sudo apt install foo")).toBe(false);
	});

	it("rejects safe-prefixed commands that contain destructive content", () => {
		// safe pattern + destructive = not safe
		expect(isSafeCommand("ls && rm -rf /")).toBe(false)
		expect(isSafeCommand("ls; python -c \"open('/tmp/x','w').write('x')\"")).toBe(
			false,
		)
		expect(isSafeCommand("echo hi > out.txt")).toBe(false) // redirect
	})

	it("rejects empty / whitespace-only strings", () => {
		expect(isSafeCommand("")).toBe(false);
		expect(isSafeCommand("   ")).toBe(false);
		expect(isSafeCommand("\n")).toBe(false);
	});

	it("rejects unknown commands", () => {
		expect(isSafeCommand("someweirdcommand foo bar")).toBe(false);
	});

	it("rejects safe-prefixed find with destructive flags", () => {
		expect(isSafeCommand("find . -delete")).toBe(false);
		expect(isSafeCommand("find . -exec rm {} \\;")).toBe(false);
	});

	it("allows literal nested markers inside single quotes", () => {
		expect(isSafeCommand("rg -F '$(' src")).toBe(true)
		expect(isSafeCommand("echo 'literal ` text'")).toBe(true)
	});

	it("still rejects nested execution outside single quotes", () => {
		expect(isSafeCommand('echo "$(rm -rf /)"')).toBe(false)
	});

	it("treats escaped semicolons as part of one command", () => {
		expect(isSafeCommand("printf foo\\;bar")).toBe(true)
	});

	it("allows stderr/stdout fd redirects commonly used by agents", () => {
		expect(isSafeCommand("ls -1 /tmp 2>&1")).toBe(true)
		expect(isSafeCommand("cat foo.txt 2>&1 | head -60")).toBe(true)
		expect(
			isSafeCommand(
				"ls -la /tmp 2>&1; cat CHANGELOG.md 2>&1 | head -60",
			),
		).toBe(true)
		expect(isSafeCommand("git status >&2")).toBe(true)
	});

	it("still rejects real file redirects", () => {
		expect(isSafeCommand("ls > out.txt")).toBe(false)
		expect(isSafeCommand("cat foo 2> err.txt")).toBe(false)
		expect(isSafeCommand("echo hi >> out.txt")).toBe(false)
	});
});

describe("isAutoFallbackBash", () => {
	it("allows routine build and test commands", () => {
		expect(isAutoFallbackBash("npm test")).toBe(true)
		expect(isAutoFallbackBash("npm run build")).toBe(true)
		expect(isAutoFallbackBash("go test ./...")).toBe(true)
		expect(isAutoFallbackBash("cargo test")).toBe(true)
	})

	// Adjudication ③ (2026-09-12): whitelist extended with dev-server script names.
	it("allows dev-server script names on the extended whitelist", () => {
		expect(isAutoFallbackBash("npm run dev")).toBe(true)
		expect(isAutoFallbackBash("npm run start")).toBe(true)
		expect(isAutoFallbackBash("pnpm run preview")).toBe(true)
		expect(isAutoFallbackBash("yarn run serve")).toBe(true)
	})

	it("rejects arbitrary package scripts", () => {
		expect(isAutoFallbackBash("npm run deploy")).toBe(false)
		expect(isAutoFallbackBash("pnpm run destroy-production")).toBe(false)
		expect(isAutoFallbackBash("npm run build-and-deploy")).toBe(false)
		expect(isAutoFallbackBash("pnpm run test:reset-db")).toBe(false)
	})

	it("rejects background compound commands", () => {
		expect(
			isAutoFallbackBash("npm test & python -c \"import os; os.system('id')\""),
		).toBe(false)
	})

	it("rejects quoted compound commands with escaped closing quotes", () => {
		expect(isAutoFallbackBash('npm test "\\\\"; npm run deploy')).toBe(false)
		expect(isAutoFallbackBash("npm test 'foo\\'; npm run deploy")).toBe(false)
		expect(isAutoFallbackBash('npm test \\"x; npm run deploy')).toBe(false)
	})

	it("rejects process substitution", () => {
		expect(isAutoFallbackBash("npm test <(npm run deploy)")).toBe(false)
	})

	it("allows stderr redirection on fallback commands", () => {
		expect(isAutoFallbackBash("npm test 2>&1")).toBe(true)
	})

	it("rejects executable and config injection flags on fallback commands", () => {
		expect(isAutoFallbackBash("go test -exec /tmp/payload ./...")).toBe(false)
		expect(isAutoFallbackBash("vitest --config /tmp/evil.config.ts")).toBe(false)
		expect(isAutoFallbackBash("jest --config=evil.config.js")).toBe(false)
		expect(isAutoFallbackBash("npm test -- node /tmp/exploit.js")).toBe(false)
		expect(isAutoFallbackBash("cmake --build /tmp/out")).toBe(false)
		expect(isAutoFallbackBash("go test -toolexec /tmp/payload ./...")).toBe(false)
		expect(isAutoFallbackBash("npm test --script-shell=/tmp/payload")).toBe(
			false,
		)
	})

	it("still allows bounded fallback commands with normal args", () => {
		expect(isAutoFallbackBash("go test ./...")).toBe(true)
		expect(isAutoFallbackBash("vitest run")).toBe(true)
		expect(isAutoFallbackBash("cmake --build .")).toBe(true)
		expect(isAutoFallbackBash("pytest tests/unit")).toBe(true)
	})

	it("rejects outside-cwd targets in fallback test commands", () => {
		expect(isAutoFallbackBash("pytest /tmp/evil.py")).toBe(false)
		expect(
			isAutoFallbackBash("cargo test --manifest-path /tmp/evil/Cargo.toml"),
		).toBe(false)
		expect(isAutoFallbackBash("go test -o /tmp/testbin")).toBe(false)
		expect(isAutoFallbackBash('go test -o "/tmp/testbin"')).toBe(false)
		expect(
			isAutoFallbackBash('cargo test --manifest-path "/tmp/evil/Cargo.toml"'),
		).toBe(false)
		expect(isAutoFallbackBash("vitest --root=../evil")).toBe(false)
		expect(isAutoFallbackBash("jest --testEnvironment=/tmp/evil.js")).toBe(
			false,
		)
	})

	it("rejects cmake install targets in fallback build commands", () => {
		expect(isAutoFallbackBash("cmake --build . --target install")).toBe(false)
	})

	it("rejects nested shell execution", () => {
		expect(
			isSafeCommand('ls $(python -c "open(\'/tmp/x\',\'w\').write(\'x\')")'),
		).toBe(false)
	})

	it("still rejects destructive compound commands", () => {
		expect(isAutoFallbackBash("npm test; rm -rf /")).toBe(false)
		expect(isAutoFallbackBash("ls; python -c \"open('/tmp/x','w').write('x')\"")).toBe(
			false,
		)
	})
});

// Adjudicated 2026-09-12 — see docs/bash-risk-adjudication-2026-09-12.md.
describe("isAutoApprovableBash (bash-risk adjudication 2026-09-12)", () => {
	it("keeps hook-free, reversible git ops in tier 2", () => {
		expect(isAutoApprovableBash("git add .")).toBe(true)
		expect(isAutoApprovableBash("git stash")).toBe(true)
		expect(isAutoApprovableBash("git branch feat")).toBe(true)
		expect(isAutoApprovableBash("git switch feat")).toBe(true)
		expect(isAutoApprovableBash("git tag v1")).toBe(true)
		expect(isAutoApprovableBash("git init")).toBe(true)
		expect(isAutoApprovableBash("git clone https://example.com/repo")).toBe(true)
		expect(isAutoApprovableBash("git reset HEAD~1")).toBe(true)
	})

	it("demotes git hook vectors and worktree-loss forms to tier 3", () => {
		// commit/merge/rebase/cherry-pick/revert run .git/hooks (repo-controlled code).
		expect(isAutoApprovableBash("git commit -m msg")).toBe(false)
		expect(isAutoApprovableBash("git merge main")).toBe(false)
		expect(isAutoApprovableBash("git rebase main")).toBe(false)
		expect(isAutoApprovableBash("git cherry-pick abc123")).toBe(false)
		expect(isAutoApprovableBash("git revert abc123")).toBe(false)
		// restore / checkout -- <path> can discard uncommitted work.
		expect(isAutoApprovableBash("git restore .")).toBe(false)
		expect(isAutoApprovableBash("git checkout -- src/app.ts")).toBe(false)
	})

	it("restricts package run-scripts to the script whitelist", () => {
		expect(isAutoApprovableBash("npm run build")).toBe(true)
		expect(isAutoApprovableBash("npm run test")).toBe(true)
		expect(isAutoApprovableBash("npm run dev")).toBe(true)
		expect(isAutoApprovableBash("pnpm run start")).toBe(true)
		expect(isAutoApprovableBash("yarn run preview")).toBe(true)
		// Non-whitelisted scripts fall to tier-3 classifier review.
		expect(isAutoApprovableBash("npm run deploy")).toBe(false)
		expect(isAutoApprovableBash("pnpm run destroy-production")).toBe(false)
	})

	it("reuses the offline fallback guardrails (unsafe args, outside-cwd paths)", () => {
		expect(isAutoApprovableBash("npm run test --config /tmp/evil.config.ts")).toBe(false)
		expect(isAutoApprovableBash("vitest --require /tmp/evil.ts")).toBe(false)
		expect(isAutoApprovableBash("mv notes.txt ~/")).toBe(false)
		expect(isAutoApprovableBash("cp src.ts /etc/passwd-copy")).toBe(false)
		expect(isAutoApprovableBash("mkdir /tmp/escape")).toBe(false)
		// cwd-relative workflow ops stay tier-2.
		expect(isAutoApprovableBash("mkdir build-out")).toBe(true)
		expect(isAutoApprovableBash("cp a.ts b.ts")).toBe(true)
	})

	it("demotes docker run/exec to tier 3 but keeps build/compose/inspect forms", () => {
		expect(isAutoApprovableBash("docker run alpine sh")).toBe(false)
		expect(isAutoApprovableBash("docker exec web sh")).toBe(false)
		expect(isAutoApprovableBash("docker build .")).toBe(true)
		expect(isAutoApprovableBash("docker compose up -d")).toBe(true)
		expect(isAutoApprovableBash("docker logs web")).toBe(true)
		expect(isAutoApprovableBash("docker ps")).toBe(true)
	})
})

// One tokenization pass must not change either verdict (plan A4).
describe("classifyBashTiers equivalence (plan A4)", () => {
	const sampleCommands = [
		"ls -la",
		"cat foo.txt | grep x",
		"git add .",
		"git commit -m x",
		"npm run dev",
		"npm run deploy",
		"mv notes.txt ~/",
		"docker run alpine",
		"rm -rf /",
		"echo hi > out.txt",
		"mkdir build-out",
		"",
		"   ",
	]

	it("matches isSafeCommand and isAutoApprovableBash on every sample", () => {
		for (const cmd of sampleCommands) {
			const tiers = classifyBashTiers(cmd)
			expect(tiers.safe).toBe(isSafeCommand(cmd))
			expect(tiers.autoApprovable).toBe(isAutoApprovableBash(cmd))
		}
	})
})

// Adjudicated 2026-09-12 — see docs/bash-risk-adjudication-2026-09-12.md.
describe("isSafeCommand tier-1 bypass fixes (bash-risk adjudication 2026-09-12)", () => {
	it("no longer treats env-prefixed commands as read-only", () => {
		expect(isSafeCommand("env")).toBe(false)
		expect(isSafeCommand("env X=1 python3 -c 'print(1)'")).toBe(false)
		expect(isSafeCommand("printenv")).toBe(true)
	})

	it("no longer treats awk as read-only (interpreter with system()/redirect vectors)", () => {
		expect(isSafeCommand("awk '{print $1}' file.txt")).toBe(false)
		expect(isSafeCommand("awk 'BEGIN{system(\"id\")}'")).toBe(false)
	})

	it("blocks sed -n write-to-file forms but keeps plain read printing", () => {
		expect(isSafeCommand("sed -n '1,5p' file.txt")).toBe(true)
		expect(isSafeCommand("sed -n '1w /tmp/x' file.txt")).toBe(false)
		expect(isSafeCommand("sed -n '1w/tmp/x' file.txt")).toBe(false)
	})

	it("treats curl/wget as destructive (defense in depth)", () => {
		expect(isSafeCommand("curl https://example.com")).toBe(false)
		expect(isSafeCommand("wget -O - https://example.com")).toBe(false)
	})
})

describe("isOutsideCwd", () => {
	const cwd = "/home/user/project";

	it("returns false for paths inside cwd", () => {
		expect(isOutsideCwd("./foo", cwd)).toBe(false);
		expect(isOutsideCwd("src/index.ts", cwd)).toBe(false);
		expect(isOutsideCwd(".", cwd)).toBe(false);
		expect(isOutsideCwd(cwd, cwd)).toBe(false);
	});

	it("returns true for paths outside cwd", () => {
		expect(isOutsideCwd("../foo", cwd)).toBe(true);
		expect(isOutsideCwd("/etc/passwd", cwd)).toBe(true);
		expect(isOutsideCwd("/tmp/something", cwd)).toBe(true);
	});

	it("returns false for empty string (no path = inside cwd by default)", () => {
		expect(isOutsideCwd("", cwd)).toBe(false);
	});

	it("treats symlinked in-cwd paths as outside when target resolves elsewhere", () => {
		const root = mkdtempSync(join(tmpdir(), "pm-outside-sym-"))
		const outside = mkdtempSync(join(tmpdir(), "pm-outside-target-"))
		const linkPath = join(root, "link")
		symlinkSync(outside, linkPath)
		expect(isOutsideCwd("link/secret.txt", root)).toBe(true)
		rmSync(root, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	});
});

describe("commandTargetsOutsideCwd", () => {
	const cwd = "/home/user/project";

	it("flags commands with absolute paths outside cwd", () => {
		expect(commandTargetsOutsideCwd("ls /etc/passwd", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("cat /tmp/foo", cwd)).toBe(true);
	});

	it("flags cd .. / ../ traversal", () => {
		expect(commandTargetsOutsideCwd("cd ..", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("ls ../sibling", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("cat ../../foo", cwd)).toBe(true);
	});

	it("flags ~ expansion", () => {
		expect(commandTargetsOutsideCwd("ls ~", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("cat ~/notes.txt", cwd)).toBe(true);
	});

	it("flags $HOME / $TMPDIR expansions", () => {
		expect(commandTargetsOutsideCwd("ls $HOME", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("cat $TMPDIR/foo", cwd)).toBe(true);
	});

	it("does NOT flag safe commands that don't reference paths", () => {
		expect(commandTargetsOutsideCwd("ls", cwd)).toBe(false);
		expect(commandTargetsOutsideCwd("ps aux", cwd)).toBe(false);
	});

	it("does NOT flag commands that only reference cwd-local paths", () => {
		expect(commandTargetsOutsideCwd("cat ./foo.txt", cwd)).toBe(false);
		expect(commandTargetsOutsideCwd("ls src/", cwd)).toBe(false);
	});

	it("flags read-only commands that reference outside paths", () => {
		expect(commandTargetsOutsideCwd("cat /etc/passwd", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("grep foo /etc/hosts", cwd)).toBe(true);
	});

	it("returns false for empty / whitespace", () => {
		expect(commandTargetsOutsideCwd("", cwd)).toBe(false);
		expect(commandTargetsOutsideCwd("   ", cwd)).toBe(false);
	});
});

describe("findProjectRoot", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "perm-modes-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("detects .git directory", () => {
		mkdirSync(join(tmpDir, ".git"));
		mkdirSync(join(tmpDir, "src"));
		expect(findProjectRoot(join(tmpDir, "src"))).toBe(tmpDir);
	});

	it("detects package.json", () => {
		writeFileSync(join(tmpDir, "package.json"), "{}");
		mkdirSync(join(tmpDir, "src"));
		expect(findProjectRoot(join(tmpDir, "src"))).toBe(tmpDir);
	});

	it("returns null when no markers found", () => {
		mkdirSync(join(tmpDir, "src"));
		expect(findProjectRoot(join(tmpDir, "src"))).toBe(null);
	});

	it("stops at the innermost project root (nested package.json)", () => {
		writeFileSync(join(tmpDir, "package.json"), "{}");
		mkdirSync(join(tmpDir, "packages"));
		mkdirSync(join(tmpDir, "packages", "app"));
		writeFileSync(join(tmpDir, "packages", "app", "package.json"), "{}");
		// walking up from packages/app should stop at packages/app (innermost)
		expect(findProjectRoot(join(tmpDir, "packages", "app"))).toBe(
			join(tmpDir, "packages", "app"),
		);
	});
});

describe("isInsideProject", () => {
	const cwd = "/home/user/project/src"
	const projectRoot = "/home/user/project"

	it("returns true for path inside project root", () => {
		expect(isInsideProject("./foo.ts", cwd, projectRoot)).toBe(true)
		expect(isInsideProject("index.ts", cwd, projectRoot)).toBe(true)
	})

	it("returns true for path outside cwd but inside project root (relaxation case)", () => {
		// cwd is /home/user/project/src, project root is /home/user/project
		// writing to ../README.md = /home/user/project/README.md → inside project
		expect(isInsideProject("../README.md", cwd, projectRoot)).toBe(true)
	})

	it("returns false for path outside project root", () => {
		expect(isInsideProject("/etc/passwd", cwd, projectRoot)).toBe(false)
		expect(isInsideProject("../../sibling/foo", cwd, projectRoot)).toBe(false)
	})

	it("returns false when project root is null", () => {
		expect(isInsideProject("./foo.ts", cwd, null)).toBe(false)
	})

	it("returns true for project root itself", () => {
		expect(isInsideProject(".", cwd, projectRoot)).toBe(true)
	})
})

describe("extractTodoItems", () => {
	it("extracts numbered items under a Plan: header", () => {
		const msg = `
Plan:
1. First step description here
2. Second step description here
3. Third step description here
`;
		const items = extractTodoItems(msg);
		expect(items.length).toBe(3);
		expect(items[0]).toMatchObject({ step: 1, completed: false });
		expect(items[1].step).toBe(2);
		expect(items[2].step).toBe(3);
	});

	it("returns empty array when no Plan: header", () => {
		expect(extractTodoItems("Just some text without a plan")).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(extractTodoItems("")).toEqual([]);
	});

	it("handles Plan: with bold markers", () => {
		const msg = `**Plan:**\n1. Step one text\n2. Step two text`;
		const items = extractTodoItems(msg);
		expect(items.length).toBe(2);
	});

	it("skips very short items", () => {
		const msg = `Plan:\n1. ok\n2. This is a real step\n`;
		const items = extractTodoItems(msg);
		// very short items may be filtered; depends on threshold (we filter < 3 chars after cleaning)
		const texts = items.map((i) => i.text);
		expect(texts.some((t) => t.includes("real step"))).toBe(true);
	});
});

describe("markCompletedSteps", () => {
	let items: TodoItem[]

	beforeEach(() => {
		items = [
			{ step: 1, text: "First", completed: false },
			{ step: 2, text: "Second", completed: false },
			{ step: 3, text: "Third", completed: false },
		]
	})

	it("marks a single [DONE:n] step", () => {
		markCompletedSteps("Finished [DONE:1]", items);
		expect(items[0].completed).toBe(true);
		expect(items[1].completed).toBe(false);
	});

	it("marks multiple [DONE:n] steps", () => {
		markCompletedSteps("Done with [DONE:1] and [DONE:2]", items);
		expect(items[0].completed).toBe(true);
		expect(items[1].completed).toBe(true);
		expect(items[2].completed).toBe(false);
	});

	it("ignores non-existent step numbers", () => {
		markCompletedSteps("Done [DONE:99]", items);
		expect(items.every((i) => !i.completed)).toBe(true);
	});

	it("handles out-of-order tags", () => {
		markCompletedSteps("Done [DONE:3] [DONE:1]", items);
		expect(items[0].completed).toBe(true);
		expect(items[2].completed).toBe(true);
	});

	it("returns 0 for no tags", () => {
		expect(markCompletedSteps("nothing here", items)).toBe(0);
	});
});

describe("isCompletionSignal", () => {
	it("matches common completion phrases", () => {
		expect(isCompletionSignal("The task is complete.")).toBe(true);
		expect(isCompletionSignal("All done.")).toBe(true);
		expect(isCompletionSignal("Plan complete.")).toBe(true);
		expect(isCompletionSignal("Everything is finished.")).toBe(true);
		expect(isCompletionSignal("I'm done.")).toBe(true);
	});

	it("does not match unrelated text", () => {
		expect(isCompletionSignal("Working on it...")).toBe(false);
		expect(isCompletionSignal("Let me check the file.")).toBe(false);
	});

	it("returns false for empty text", () => {
		expect(isCompletionSignal("")).toBe(false);
	});
});

describe("formatCount", () => {
	it("returns 0 for 0", () => {
		expect(formatCount(0)).toBe("0");
	});

	it("returns the number for small values", () => {
		expect(formatCount(1)).toBe("1");
		expect(formatCount(999)).toBe("999");
	});

	it("formats thousands as k", () => {
		expect(formatCount(1234)).toBe("1.2k");
		expect(formatCount(9999)).toBe("10.0k");
		expect(formatCount(12000)).toBe("12k");
	});

	it("handles invalid numbers", () => {
		expect(formatCount(NaN)).toBe("0");
		expect(formatCount(Infinity)).toBe("0");
		expect(formatCount(-100)).toBe("0");
	});
});
describe("getProjectId", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-pid-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns existing hash from .pi/permission-modes-*.md", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "permission-modes-45ea0551.md"),
			"# project marker",
		);
		expect(getProjectId(tmpDir)).toBe("45ea0551");
	});

	it("falls back to cwd hash when no marker exists", () => {
		const id = getProjectId(tmpDir);
		expect(id).toMatch(/^[a-f0-9]{8}$/);
		expect(id).toBe(getProjectId(tmpDir)); // deterministic
	});

	it("falls back when .pi/ exists but no permission-modes-*.md", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(join(tmpDir, ".pi", "other.md"), "");
		const id = getProjectId(tmpDir);
		expect(id).toMatch(/^[a-f0-9]{8}$/);
	})

	it("switches from hash fallback to marker id when the marker appears mid-session", () => {
		// Positive-only caching (plan A2): a marker created after the first
		// hash-fallback call must win on the next call.
		const before = getProjectId(tmpDir);
		expect(before).toMatch(/^[a-f0-9]{8}$/);
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "permission-modes-deadbeef.md"),
			"# project marker",
		);
		expect(getProjectId(tmpDir)).toBe("deadbeef");
	})
});

describe("hashPath", () => {
	it("returns deterministic 8-char hex hash", () => {
		expect(hashPath("/etc/passwd")).toMatch(/^[a-f0-9]{8}$/);
		expect(hashPath("/etc/passwd")).toBe(hashPath("/etc/passwd"));
	});

	it("returns different hashes for different paths", () => {
		expect(hashPath("/etc/passwd")).not.toBe(hashPath("/etc/hosts"));
	});

	it("handles empty string", () => {
		expect(hashPath("")).toMatch(/^[a-f0-9]{8}$/);
	});
});

describe("getProjectTmpDir", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-tmp-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .pi/projects/<id>/tmp/outside-writes/", () => {
		const result = getProjectTmpDir(tmpDir);
		expect(existsSync(result)).toBe(true);
		expect(result).toContain(".pi/projects/");
		expect(result).toContain("/tmp/outside-writes");
		expect(result.startsWith(tmpDir)).toBe(true);
	});

	it("uses existing project hash when present", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "permission-modes-deadbeef.md"),
			"",
		);
		expect(getProjectTmpDir(tmpDir)).toContain("/deadbeef/");
	});

	it("is idempotent (second call returns same path)", () => {
		const a = getProjectTmpDir(tmpDir);
		const b = getProjectTmpDir(tmpDir);
		expect(a).toBe(b);
	});
});


describe("trackOutsideWrite + listTrackedOutsideWrites", () => {
	let tmpDir: string;
	let cwd: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-track-"));
		cwd = tmpDir;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes a snapshot file with all fields", () => {
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: "/home/user/.bashrc",
			toolName: "write",
			backupContent: "old content\n",
		};
		trackOutsideWrite(cwd, snap);
		const list = listTrackedOutsideWrites(cwd);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject(snap);
	});

	it("records null backupContent for new files", () => {
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: "/tmp/brand-new.txt",
			toolName: "write",
			backupContent: null,
		};
		trackOutsideWrite(cwd, snap);
		expect(listTrackedOutsideWrites(cwd)[0].backupContent).toBeNull();
	});

	it("sorts multiple snapshots by timestamp ascending", () => {
		trackOutsideWrite(cwd, { timestamp: "2026-06-29T12:00:02.000Z", originalPath: "/a", toolName: "write", backupContent: null });
		trackOutsideWrite(cwd, { timestamp: "2026-06-29T12:00:01.000Z", originalPath: "/b", toolName: "edit", backupContent: "x" });
		trackOutsideWrite(cwd, { timestamp: "2026-06-29T12:00:03.000Z", originalPath: "/c", toolName: "write", backupContent: null });
		const list = listTrackedOutsideWrites(cwd);
		expect(list.map((s) => s.originalPath)).toEqual(["/b", "/a", "/c"]);
	});

	it("returns empty array when no snapshots exist", () => {
		expect(listTrackedOutsideWrites(cwd)).toEqual([]);
	});

	it("skips malformed snapshot files without throwing", () => {
		const dir = getProjectTmpDir(cwd);
		writeFileSync(join(dir, "garbage.json"), "{not json");
		expect(listTrackedOutsideWrites(cwd)).toEqual([]);
	});

	it("caps at MAX_TRACKED_WRITES (100) and LRU-evicts oldest", () => {
		// Insert 101 snapshots with increasing timestamps
		for (let i = 0; i < 101; i++) {
			trackOutsideWrite(cwd, {
				timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
				originalPath: `/p/${i}`,
				toolName: "write",
				backupContent: null,
			});
		}
		const list = listTrackedOutsideWrites(cwd);
		expect(list).toHaveLength(100);
		// Oldest (i=0) should be evicted
		expect(list[0].originalPath).toBe("/p/1");
		// Newest (i=100) should remain
		expect(list[99].originalPath).toBe("/p/100");
	});
});

describe("restoreOutsideWrite + popTrackedOutsideWrite", () => {
	let tmpDir: string;
	let outsideFile: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-restore-"));
		outsideFile = join(tmpDir, "outside.txt");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("restores backup content when backupContent is non-null", () => {
		writeFileSync(outsideFile, "new content");
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: outsideFile,
			toolName: "write",
			backupContent: "original content",
		};
		const result = restoreOutsideWrite(snap);
		expect(result).toEqual({ restored: true, action: "restored" });
		expect(readFileSync(outsideFile, "utf-8")).toBe("original content");
	});

	it("deletes file when backupContent is null", () => {
		writeFileSync(outsideFile, "new content");
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: outsideFile,
			toolName: "write",
			backupContent: null,
		};
		const result = restoreOutsideWrite(snap);
		expect(result).toEqual({ restored: true, action: "deleted" });
		expect(existsSync(outsideFile)).toBe(false);
	});

	it("returns noop when file already restored", () => {
		// backupContent is "original" but file was never written by the write
		writeFileSync(outsideFile, "original");
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: outsideFile,
			toolName: "write",
			backupContent: "original",
		};
		const result = restoreOutsideWrite(snap);
		// Content matches, so no change needed
		expect(result.action).toBe("noop");
		expect(readFileSync(outsideFile, "utf-8")).toBe("original");
	});

	it("deletes file on noop when backupContent is null and file missing", () => {
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: outsideFile, // doesn't exist
			toolName: "write",
			backupContent: null,
		};
		const result = restoreOutsideWrite(snap);
		expect(result.action).toBe("noop");
	});

	it("popTrackedOutsideWrite removes the snapshot file", () => {
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: "/x",
			toolName: "write",
			backupContent: null,
		};
		trackOutsideWrite(tmpDir, snap);
		expect(listTrackedOutsideWrites(tmpDir)).toHaveLength(1);
		popTrackedOutsideWrite(tmpDir, snap);
		expect(listTrackedOutsideWrites(tmpDir)).toHaveLength(0);
	});

	it("popTrackedOutsideWrite is safe when file missing", () => {
		const snap: OutsideWriteSnapshot = {
			timestamp: "2026-06-29T12:00:00.000Z",
			originalPath: "/x",
			toolName: "write",
			backupContent: null,
		};
		expect(() => popTrackedOutsideWrite(tmpDir, snap)).not.toThrow();
	});
});

// ---- filterSkillsFromPrompt --------------------------------------------

// ---- filterSkillsFromPrompt --------------------------------------------
//
// IMPORTANT: The skill block format used here MUST match what pi's
// `formatSkillsForPrompt()` emits (see `node_modules/@earendil-works/
// pi-coding-agent/dist/core/skills.js`). The actual emitted XML is:
//
//   <available_skills>
//     <skill>
//       <name>SKILL_NAME</name>
//       <description>...</description>
//       <location>...absolute path to SKILL.md...</location>
//     </skill>
//     ...
//   </available_skills>
//
// NOT the Agent Skills spec `<skill name="...">` attribute format. The
// v1.1.4 implementation used the wrong format — all 21 skills leaked
// through regardless of the `model-profiles.json` allowlist (v1.1.5 fix).

describe("filterSkillsFromPrompt", () => {
	const sampleSkillBlock =
		"  <skill>\n" +
		"    <name>systematic-debugging</name>\n" +
		"    <description>Use when encountering any bug</description>\n" +
		"    <location>/home/user/.pi/agent/skills/systematic-debugging/SKILL.md</location>\n" +
		"  </skill>"

	const multiSkillPrompt = [
		"<available_skills>",
		"  <skill>",
		"    <name>brainstorming</name>",
		"    <description>Use before any creative work</description>",
		"    <location>/home/user/.pi/agent/skills/brainstorming/SKILL.md</location>",
		"  </skill>",
		"  <skill>",
		"    <name>writing-plans</name>",
		"    <description>Use when you have a spec</description>",
		"    <location>/home/user/.pi/agent/skills/writing-plans/SKILL.md</location>",
		"  </skill>",
		sampleSkillBlock,
		"</available_skills>",
		"",
		"## Available tools",
		"- read: Read files",
		"- bash: Execute commands",
	].join("\n")

	it("returns prompt unchanged when allowedSkills is ['*']", () => {
		const result = filterSkillsFromPrompt(multiSkillPrompt, ["*"])
		expect(result).toBe(multiSkillPrompt)
	})

	it("returns prompt unchanged when allowedSkills is empty", () => {
		const result = filterSkillsFromPrompt(multiSkillPrompt, [])
		expect(result).toBe(multiSkillPrompt)
	})

	it("returns prompt unchanged when no skill blocks found", () => {
		const plain = "Just a regular prompt without skill blocks."
		const result = filterSkillsFromPrompt(plain, ["brainstorming"])
		expect(result).toBe(plain)
	})

	it("returns prompt unchanged when allowedSkills includes all present skills", () => {
		const result = filterSkillsFromPrompt(multiSkillPrompt, [
			"brainstorming",
			"writing-plans",
			"systematic-debugging",
		])
		expect(result).toBe(multiSkillPrompt)
	})

	it("removes skill blocks not in the allowlist", () => {
		const result = filterSkillsFromPrompt(multiSkillPrompt, [
			"brainstorming",
			"writing-plans",
		])

		// Should still contain the allowed skills
		expect(result).toContain("brainstorming")
		expect(result).toContain("writing-plans")
		// Should NOT contain the filtered skill
		expect(result).not.toContain("systematic-debugging")
		// Should still contain non-skill content
		expect(result).toContain("Available tools")
		// Wrapper tags should still be present (we don't strip <available_skills>)
		expect(result).toContain("<available_skills>")
		expect(result).toContain("</available_skills>")
	})

	it("removes ALL skill blocks when allowedSkills list doesn't match any", () => {
		const result = filterSkillsFromPrompt(multiSkillPrompt, [
			"nonexistent-skill",
		])
		expect(result).not.toContain("<skill>")
		expect(result).not.toContain("</skill>")
		expect(result).not.toContain("brainstorming")
		expect(result).not.toContain("systematic-debugging")
		expect(result).toContain("Available tools")
		// Wrapper stays — caller can decide what to do with empty <available_skills>
		expect(result).toContain("<available_skills>")
		expect(result).toContain("</available_skills>")
	})

	it("handles multiline skill description and content", () => {
		const prompt = [
			"<available_skills>",
			"  <skill>",
			"    <name>multi</name>",
			"    <description>test</description>",
			"    <location>/path/to/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
		].join("\n")
		const result = filterSkillsFromPrompt(prompt, ["multi"])
		expect(result).toBe(prompt)
	})

	it("preserves description and location of kept skills", () => {
		// Ensure we don't accidentally keep just the <name> and lose
		// the description/location lines.
		const result = filterSkillsFromPrompt(multiSkillPrompt, ["brainstorming"])
		expect(result).toContain("Use before any creative work")
		expect(result).toContain("/home/user/.pi/agent/skills/brainstorming/SKILL.md")
		expect(result).not.toContain("Use when you have a spec")
		expect(result).not.toContain("/home/user/.pi/agent/skills/writing-plans/SKILL.md")
	})

	it("handles a realistic mixed prompt (skills + instructions + mode context)", () => {
		const realisticPrompt = [
			"You are a helpful coding assistant...",
			"",
			"<available_skills>",
			"  <skill>",
			"    <name>brainstorming</name>",
			"    <description>Use before any creative work</description>",
			"    <location>/home/user/.pi/agent/skills/brainstorming/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>systematic-debugging</name>",
			"    <description>Debug systematically</description>",
			"    <location>/home/user/.pi/agent/skills/systematic-debugging/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
			"",
			"[ASK MODE ACTIVE] Standard mode...",
			"",
			"## Available tools",
			"- read",
			"- bash",
		].join("\n")

		const result = filterSkillsFromPrompt(realisticPrompt, ["brainstorming"])

		expect(result).toContain("brainstorming")
		expect(result).toContain("Use before any creative work")
		expect(result).not.toContain("systematic-debugging")
		expect(result).not.toContain("Debug systematically")
		expect(result).toContain("[ASK MODE ACTIVE]")
		expect(result).toContain("Available tools")
	})

	it("is a no-op for empty string prompt", () => {
		expect(filterSkillsFromPrompt("", ["brainstorming"])).toBe("")
	})

	it("handles skill name at regex boundary (single char)", () => {
		// Per Agent Skills spec, names are [a-z0-9-] with min length 1
		const prompt = [
			"<available_skills>",
			"  <skill>",
			"    <name>a</name>",
			"    <description>single</description>",
			"    <location>/x/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
		].join("\n")
		const result = filterSkillsFromPrompt(prompt, ["a"])
		expect(result).toBe(prompt)
	})

	it("preserves whitespace between remaining skill blocks", () => {
		const prompt = [
			"<available_skills>",
			"  <skill>",
			"    <name>a</name>",
			"    <description>a</description>",
			"    <location>/a/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>b</name>",
			"    <description>b</description>",
			"    <location>/b/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>c</name>",
			"    <description>c</description>",
			"    <location>/c/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
		].join("\n")
		const result = filterSkillsFromPrompt(prompt, ["a", "c"])
		// Should keep a and c, remove b
		expect(result).toContain("<name>a</name>")
		expect(result).toContain("<name>c</name>")
		expect(result).not.toContain("<name>b</name>")
		expect(result).not.toContain("/b/SKILL.md")
	})

	it("handles consecutive non-skill text correctly", () => {
		const prompt = [
			"Header",
			"",
			"<available_skills>",
			"  <skill>",
			"    <name>skill-a</name>",
			"    <description>a</description>",
			"    <location>/a/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>skill-b</name>",
			"    <description>b</description>",
			"    <location>/b/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
			"",
			"Middle text",
			"",
			"Footer",
		].join("\n")
		const result = filterSkillsFromPrompt(prompt, ["skill-a"])
		expect(result).toContain("Header")
		expect(result).toContain("Middle text")
		expect(result).toContain("Footer")
		expect(result).not.toContain("skill-b")
		expect(result).not.toContain("/b/SKILL.md")
	})

	it("does NOT match the Agent Skills spec attribute format (regression guard)", () => {
		// The bug from v1.1.4: regex matched `<skill name="...">` instead of
		// pi's actual `<skill><name>...</name>...</skill>` schema. This guard
		// ensures the filter does NOT silently pass through skills just
		// because the prompt uses an unrelated format.
		const attrFormatPrompt = [
			"<available_skills>",
			'<skill name="brainstorming" location="/x">',
			"  Brainstorming body",
			"</skill>",
			'<skill name="writing-plans" location="/y">',
			"  Writing plans body",
			"</skill>",
			"</available_skills>",
		].join("\n")
		const result = filterSkillsFromPrompt(attrFormatPrompt, ["brainstorming"])
		// We document the v1.1.5 behavior: the regex is keyed on the <skill>
		// wrapper + child <name> element, so the attribute format is treated
		// as opaque non-matching content. The skill NAMES happen to still be
		// substring-matched by `not.toContain`, but the OUTER <skill name=...>
		// wrappers remain intact. This guards against a regression where the
		// regex silently expands to swallow the wrong format.
		expect(result).toContain('<skill name="brainstorming"')
		expect(result).toContain('<skill name="writing-plans"')
	})

	it("matches the EXACT output of pi's formatSkillsForPrompt (integration)", () => {
		// Verbatim copy of the format emitted by `@earendil-works/
		// pi-coding-agent/dist/core/skills.js:formatSkillsForPrompt`.
		// If pi ever changes this schema, this test must be updated FIRST,
		// then the regex in utils.ts.
		const realFormatPrompt = [
			"",
			"",
			"The following skills provide specialized instructions for specific tasks.",
			"Use the read tool to load a skill's file when the task matches its description.",
			"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
			"",
			"<available_skills>",
			"  <skill>",
			"    <name>brainstorming</name>",
			"    <description>You MUST use this before any creative work</description>",
			"    <location>/home/user/.pi/agent/skills/brainstorming/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>systematic-debugging</name>",
			"    <description>Use when encountering any bug</description>",
			"    <location>/home/user/.pi/agent/skills/systematic-debugging/SKILL.md</location>",
			"  </skill>",
			"  <skill>",
			"    <name>caveman</name>",
			"    <description>Ultra-compressed communication</description>",
			"    <location>/home/user/.pi/agent/skills/caveman/SKILL.md</location>",
			"  </skill>",
			"</available_skills>",
			"Current date: 2026-06-29",
			"Current working directory: /home/user/proj",
		].join("\n")

		const result = filterSkillsFromPrompt(realFormatPrompt, [
			"brainstorming",
			"using-superpowers",
			"writing-plans",
		])

		// Allowed skills present
		expect(result).toContain("<name>brainstorming</name>")
		// Disallowed skills removed
		expect(result).not.toContain("<name>systematic-debugging</name>")
		expect(result).not.toContain("<name>caveman</name>")
		expect(result).not.toContain(
			"/home/user/.pi/agent/skills/systematic-debugging/SKILL.md",
		)
		// Non-skill content preserved
		expect(result).toContain("The following skills provide specialized instructions")
		expect(result).toContain("Current date: 2026-06-29")
		expect(result).toContain("Current working directory: /home/user/proj")
		// Wrapper tags preserved (caller decides what to do with empty)
		expect(result).toContain("<available_skills>")
		expect(result).toContain("</available_skills>")
	})
})

describe("injectModePrompt", () => {
	it("injects anchor block and replaces previous block", () => {
		const base = "Base prompt\n"
		const first = injectModePrompt(base, "[Ask] reminder")
		expect(first).toContain("<!-- permission-modes:context -->")
		expect(first).toContain("[Ask] reminder")
		const second = injectModePrompt(first, "[Plan] new")
		expect(second.match(/<!-- permission-modes:context -->/g)?.length).toBe(1)
		expect(second).toContain("[Plan] new")
		expect(second).not.toContain("[Ask] reminder")
	})

	it("returns stripped prompt when mode block is empty", () => {
		const withBlock = injectModePrompt("base", "[Ask] x")
		expect(injectModePrompt(withBlock, "").trimEnd()).toBe("base")
	})
})

describe("resolveModePrompt", () => {
	it("returns ask reminder only when flagged", () => {
		expect(resolveModePrompt({ mode: "ask" })).toBe("")
		expect(
			resolveModePrompt({ mode: "ask", needsAskReminder: true }),
		).toContain("[Ask]")
	})

	it("returns plan path block", () => {
		const block = resolveModePrompt({
			mode: "plan",
			planFilePath: "/tmp/plan.md",
		})
		expect(block).toContain("/tmp/plan.md")
	})

	it("auto has no routine injection", () => {
		expect(resolveModePrompt({ mode: "auto" })).toBe("")
	})
})

describe("plan helpers", () => {
	it("filters placeholder plan items", () => {
		expect(isPlaceholderPlanItem("(pending)")).toBe(true)
		expect(filterSubstantivePlanItems([
			{ step: 1, text: "(pending)", completed: false },
			{ step: 2, text: "Implement feature", completed: false },
		])).toHaveLength(1)
	})

	it("extractPlanSection returns only plan block", () => {
		const section = extractPlanSection("Intro\n\nPlan:\n1. Do thing\n\nDone.")
		expect(section).toContain("Plan:")
		expect(section).not.toContain("Intro")
	})

	it("isPlanFilePath uses cwd", () => {
		const cwd = "/proj"
		const planPath = getPlanFilePath(cwd)
		expect(isPlanFilePath(planPath, cwd)).toBe(true)
		expect(isPlanFilePath("plan.md", cwd)).toBe(false)
	})

	it("isPlanFilePath expands tilde paths", () => {
		const home = homedir()
		const cwd = join(home, "proj")
		const planPath = getPlanFilePath(cwd)
		const tildePath = `~${planPath.slice(home.length)}`
		expect(isPlanFilePath(tildePath, cwd)).toBe(true)
	})

	it("rejects symlinked plan file targets", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pm-plan-sym-"))
		const planPath = getPlanFilePath(cwd)
		mkdirSync(dirname(planPath), { recursive: true })
		const outside = join(tmpdir(), `outside-plan-${Date.now()}.md`)
		writeFileSync(outside, "outside")
		symlinkSync(outside, planPath)
		expect(isPlanFilePath(planPath, cwd)).toBe(false)
		rmSync(cwd, { recursive: true, force: true })
		rmSync(outside, { force: true })
	})

	it("shouldSyncAssistantPlanToFile guards hand-edited content", () => {
		expect(shouldSyncAssistantPlanToFile(null)).toBe(true)
		expect(shouldSyncAssistantPlanToFile("# My custom notes\nno plan header")).toBe(
			false,
		)
		expect(
			shouldSyncAssistantPlanToFile(
				"<!-- permission-modes:plan -->\nPlan:\n1. (pending)",
			),
		).toBe(true)
	})
})

describe("isOutsideCwd with tilde", () => {
	it("treats ~/outside as outside project cwd", () => {
		const cwd = join(homedir(), "project")
		expect(isOutsideCwd("~/secrets.txt", cwd)).toBe(true)
	})
})

describe("isSensitivePath", () => {
	const cwd = "/home/user/project"

	it("flags .git paths", () => {
		expect(isSensitivePath(".git/config", cwd)).toBe(true)
		expect(isSensitivePath("../other/.git/HEAD", cwd)).toBe(true)
	})

	it("flags .env files", () => {
		expect(isSensitivePath(".env", cwd)).toBe(true)
		expect(isSensitivePath(".env.local", cwd)).toBe(true)
	})

	it("allows ordinary project files", () => {
		expect(isSensitivePath("src/foo.ts", cwd)).toBe(false)
		expect(isSensitivePath("/etc/passwd", cwd)).toBe(false)
	})
})

describe("commandReferencesSensitivePath", () => {
	it("flags commands touching .git or .env", () => {
		expect(commandReferencesSensitivePath("cat .git/config")).toBe(true)
		expect(commandReferencesSensitivePath("grep foo .env")).toBe(true)
	})

	it("allows ordinary read-only commands", () => {
		expect(commandReferencesSensitivePath("cat ~/.zshrc")).toBe(false)
		expect(commandReferencesSensitivePath("git status")).toBe(false)
	})
})

describe("checkAutoRisk", () => {
	const cwd = "/home/user/project"

	it("flags risky bash and outside writes", () => {
		expect(checkAutoRisk({ tool: "bash", command: "rm -rf /" }, cwd).match).toBe(
			true,
		)
		expect(
			checkAutoRisk({ tool: "write", path: "/etc/hosts" }, cwd).match,
		).toBe(true)
	})

	it("allows file-descriptor duplication in bash commands", () => {
		expect(
			checkAutoRisk({ tool: "bash", command: "npm test 2>&1" }, cwd).match,
		).toBe(false)
	})

	it("blocks bash file redirects through >&", () => {
		expect(
			checkAutoRisk(
				{ tool: "bash", command: "npm test >& /tmp/out.log" },
				cwd,
			).match,
		).toBe(true)
	})
})
