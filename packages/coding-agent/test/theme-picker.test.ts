import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorToHex } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getThemeByName,
	setRegisteredThemes,
} from "../src/modes/interactive/theme/theme.ts";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

describe("theme picker", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-picker-"));
		const agentDir = join(tempRoot, "agent");
		vi.stubEnv("CHALICE_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(agentDir, "themes"), { recursive: true });
		setRegisteredThemes([]);
	});

	afterEach(() => {
		setRegisteredThemes([]);
		rmSync(tempRoot, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("uses custom theme content names instead of file names", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "bar",
		};

		const themePath = join(process.env.CHALICE_CODING_AGENT_DIR!, "themes", "foo.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		expect(getAvailableThemes()).toContain("bar");
		expect(getAvailableThemes()).not.toContain("foo");
		expect(getAvailableThemesWithPaths()).toContainEqual({ name: "bar", path: themePath });
		expect(getAvailableThemesWithPaths().some((theme) => theme.name === "foo")).toBe(false);
	});

	it("includes every built-in color variant", () => {
		expect(getAvailableThemes()).toEqual([
			"system",
			"dark",
			"dry-black",
			"dry-blue",
			"dry-green",
			"dry-orange",
			"dry-purple",
			"dry-red",
			"dry-yellow",
			"light",
			"vivid-black",
			"vivid-blue",
			"vivid-green",
			"vivid-orange",
			"vivid-purple",
			"vivid-red",
			"vivid-yellow",
		]);
	});

	it("applies a distinct accent palette to each dry color variant", () => {
		const accents = ["dry-blue", "dry-green", "dry-orange", "dry-purple", "dry-red", "dry-yellow"].map((name) => {
			const accent = getThemeByName(name)?.colors.accent;
			return accent === undefined ? undefined : colorToHex(accent);
		});

		expect(accents.every((accent) => accent !== undefined)).toBe(true);
		expect(new Set(accents).size).toBe(accents.length);
	});
});
