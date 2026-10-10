import { beforeAll, describe, expect, it, vi } from "vitest";
import { OnboardingComponent, type OnboardingOptions } from "../src/modes/interactive/components/onboarding.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createOnboarding(optionsOverrides: Partial<OnboardingOptions> = {}) {
	const onAction = vi.fn();
	const onUsernameChange = vi.fn();
	const options: OnboardingOptions = {
		statuses: {
			model: "configured",
			webSearch: "configured",
			semanticIndex: "configured",
		},
		usernameEnabled: true,
		username: "Tester",
		onAction,
		onUsernameChange,
		...optionsOverrides,
	};
	const component = new OnboardingComponent(options);
	return { component, onAction, onUsernameChange };
}

describe("OnboardingComponent appearance customization", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	it("prompts for appearance customization after name step when usernameEnabled is true", () => {
		const { component, onAction } = createOnboarding({ usernameEnabled: true });

		// Finish setup is available since all steps are configured
		// Navigate to "Finish setup" and select it
		// Actions: [Configure model, Skip model, Configure web, Skip web, Configure index, Skip index, Finish setup]
		// Let's press down until we reach Finish setup
		for (let i = 0; i < 10; i++) {
			component.handleInput("\x1b[B"); // down arrow
		}
		component.handleInput("\r"); // select "Finish setup"

		let output = stripAnsi(component.render(120).join("\n"));
		expect(output).toContain("Last step - what's your name?");

		// Confirm name
		component.handleInput("\r");

		output = stripAnsi(component.render(120).join("\n"));
		expect(output).toContain("Do you want to customise Chalice's appearance?");
		expect(output).toContain("Yes");
		expect(output).toContain("No");

		// Select "Yes" (default selected index 0)
		component.handleInput("\r");
		expect(onAction).toHaveBeenCalledWith("customize-appearance");
	});

	it("prompts for appearance customization directly when usernameEnabled is false", () => {
		const { component, onAction } = createOnboarding({ usernameEnabled: false });

		for (let i = 0; i < 10; i++) {
			component.handleInput("\x1b[B");
		}
		component.handleInput("\r");

		const output = stripAnsi(component.render(120).join("\n"));
		expect(output).toContain("Do you want to customise Chalice's appearance?");
		expect(output).not.toContain("Last step - what's your name?");

		// Select "Yes"
		component.handleInput("\r");
		expect(onAction).toHaveBeenCalledWith("customize-appearance");
	});

	it("ends onboarding with completion summary when selecting 'No'", () => {
		const { component, onAction } = createOnboarding({ usernameEnabled: false });

		for (let i = 0; i < 10; i++) {
			component.handleInput("\x1b[B");
		}
		component.handleInput("\r");

		let output = stripAnsi(component.render(120).join("\n"));
		expect(output).toContain("Do you want to customise Chalice's appearance?");

		// Navigate to "No" (index 1)
		component.handleInput("\x1b[B"); // down arrow
		component.handleInput("\r"); // select "No"

		expect(onAction).not.toHaveBeenCalledWith("customize-appearance");

		output = stripAnsi(component.render(120).join("\n"));
		expect(output).toContain("Onboarding complete");

		// Press enter to finish
		component.handleInput("\r");
		expect(onAction).toHaveBeenCalledWith("done");
	});

	it("ends onboarding when cancelling in appearance prompt", () => {
		const { component, onAction } = createOnboarding({ usernameEnabled: false });

		for (let i = 0; i < 10; i++) {
			component.handleInput("\x1b[B");
		}
		component.handleInput("\r");

		// Press escape
		component.handleInput("\x1b");

		expect(onAction).not.toHaveBeenCalledWith("customize-appearance");
		const output = stripAnsi(component.render(120).join("\n"));
		expect(output).toContain("Onboarding complete");
	});

	it("prompts for appearance customization when skipping name in name step", () => {
		const { component } = createOnboarding({ usernameEnabled: true });

		for (let i = 0; i < 10; i++) {
			component.handleInput("\x1b[B");
		}
		component.handleInput("\r");

		let output = stripAnsi(component.render(120).join("\n"));
		expect(output).toContain("Last step - what's your name?");

		// Press escape to skip name
		component.handleInput("\x1b");

		output = stripAnsi(component.render(120).join("\n"));
		expect(output).toContain("Do you want to customise Chalice's appearance?");
	});
});
