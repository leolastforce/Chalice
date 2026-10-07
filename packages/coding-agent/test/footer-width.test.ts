import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFooterData(extensionStatuses: ReadonlyMap<string, string> = new Map()): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders no token, cache, or cost stats", () => {
		const footer = new FooterComponent(createFooterData());

		expect(footer.render(120)).toEqual([""]);
	});

	it("renders the experimental indicator when experiments are enabled", () => {
		process.env.PI_EXPERIMENTAL = "1";
		try {
			const footer = new FooterComponent(createFooterData());

			const lines = footer.render(120);
			expect(lines).toHaveLength(2);
			expect(stripAnsi(lines[1]!)).toBe("• xp");
		} finally {
			delete process.env.PI_EXPERIMENTAL;
		}
	});

	it("keeps every line within width for long extension statuses", () => {
		const statuses = new Map<string, string>([
			["ext-a", "a".repeat(80)],
			["ext-b", "模".repeat(30)],
			["ext-c", "multi\nline status"],
		]);
		const footer = new FooterComponent(createFooterData(statuses));

		const lines = footer.render(60);
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}

		const status = stripAnsi(lines[1]!);
		expect(status).not.toContain("\n");
	});
});
