import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export type OnboardingStepId = "model" | "webSearch" | "semanticIndex";
export type OnboardingStepStatus = "pending" | "confirmation" | "configured" | "skipped";
export type OnboardingAction =
	| `configure:${OnboardingStepId}`
	| `confirm:${OnboardingStepId}`
	| `skip:${OnboardingStepId}`
	| "finish"
	| "exit"
	| "done";

export type OnboardingStatuses = Record<OnboardingStepId, OnboardingStepStatus>;

export interface OnboardingOptions {
	statuses: OnboardingStatuses;
	onAction: (action: OnboardingAction) => void;
}

const STEPS: Array<{ id: OnboardingStepId; label: string; heading: string; description: string }> = [
	{
		id: "model",
		label: "Model provider",
		heading: "Set up your model provider",
		description: "Connect a model provider to power Chalice.",
	},
	{
		id: "webSearch",
		label: "Web search",
		heading: "Set up your web search provider",
		description: "Exa is recommended; Firecrawl is set up by default.",
	},
	{
		id: "semanticIndex",
		label: "Semantic file indexing",
		heading: "Semantic file indexing",
		description: "Highly recommended: smart file search that saves context memory.",
	},
];

/** Guided setup screen with explicit skip actions and confirmed exit. */
export class OnboardingComponent extends Container {
	private selectedIndex = 0;
	private confirmingExit = false;
	private completed = false;
	private readonly options: OnboardingOptions;

	constructor(options: OnboardingOptions) {
		super();
		this.options = options;
		this.update();
	}

	private get actions(): Array<{ label: string; action: OnboardingAction }> {
		const actions: Array<{ label: string; action: OnboardingAction }> = [];
		for (const step of STEPS) {
			if (this.options.statuses[step.id] === "confirmation") {
				actions.push({ label: `Confirm ${step.label.toLowerCase()} setup`, action: `confirm:${step.id}` });
			}
			actions.push({ label: `Configure ${step.label.toLowerCase()}`, action: `configure:${step.id}` });
			actions.push({ label: `Skip ${step.label.toLowerCase()} for now`, action: `skip:${step.id}` });
		}
		if (STEPS.every((step) => ["configured", "skipped"].includes(this.options.statuses[step.id]))) {
			actions.push({ label: "Finish setup", action: "finish" });
		}
		return actions;
	}

	private update(): void {
		this.clear();
		this.addChild(new DynamicBorder());

		if (this.confirmingExit) {
			this.renderExitConfirmation();
			return;
		}
		if (this.completed) {
			this.renderCompletionSummary();
			return;
		}

		this.addChild(new Text(theme.fg("accent", theme.bold("Welcome to Chalice setup")), 1, 0));
		this.addChild(
			new Text(
				theme.fg("text", "Choose setup actions below. Every step is optional; return later with /onboarding."),
				1,
				0,
			),
		);

		const completed = STEPS.filter((step) =>
			["configured", "skipped"].includes(this.options.statuses[step.id]),
		).length;
		this.addChild(new Text(theme.fg("muted", `Progress: ${completed}/${STEPS.length} steps handled`), 1, 0));
		for (const [index, step] of STEPS.entries()) {
			const status = this.options.statuses[step.id];
			const statusText =
				status === "configured"
					? theme.fg("success", "Configured")
					: status === "skipped"
						? theme.fg("muted", "Skipped")
						: status === "confirmation"
							? theme.fg("warning", "Confirm setup")
							: theme.fg("warning", "Not set up");
			this.addChild(new Text(`${theme.fg("accent", `Step ${index + 1}/3 - ${step.heading}:`)} ${statusText}`, 1, 0));
			this.addChild(new Text(theme.fg("muted", `   ${step.description}`), 1, 0));
		}

		this.addChild(new Spacer(1));
		const actions = this.actions;
		this.selectedIndex = Math.min(this.selectedIndex, actions.length - 1);
		for (const [index, action] of actions.entries()) {
			const selected = index === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const label = selected ? theme.fg("accent", action.label) : theme.fg("text", action.label);
			this.addChild(new Text(`${prefix}${label}`, 1, 0));
		}

		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "exit options"),
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder());
	}
	private renderCompletionSummary(): void {
		this.addChild(new Text(theme.fg("success", theme.bold("Onboarding complete")), 1, 0));
		this.addChild(new Text(theme.fg("text", "Setup summary:"), 1, 0));
		for (const step of STEPS) {
			const status = this.options.statuses[step.id];
			const statusText = status === "configured" ? theme.fg("success", "Configured") : theme.fg("muted", "Skipped");
			this.addChild(new Text(`  ${step.label}: ${statusText}`, 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"text",
					"Next: use /help to explore commands, /model to change models, or /onboarding to run setup again.",
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new Text(keyHint("tui.select.confirm", "continue"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private renderExitConfirmation(): void {
		this.addChild(new Text(theme.fg("warning", theme.bold("Leave onboarding?")), 1, 0));
		this.addChild(
			new Text(
				theme.fg(
					"text",
					"Leaving now discards onboarding progress; any provider settings already saved will remain in place.",
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addOption("Continue setup", 0);
		this.addOption("Exit onboarding", 1);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "continue setup"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private addOption(label: string, index: number): void {
		const selected = this.selectedIndex === index;
		const prefix = selected ? theme.fg("accent", "→ ") : "  ";
		const text = selected ? theme.fg("accent", label) : theme.fg("text", label);
		this.addChild(new Text(`${prefix}${text}`, 1, 0));
	}

	private moveSelection(delta: number): void {
		const actionCount = this.confirmingExit ? 2 : this.actions.length;
		this.selectedIndex = Math.max(0, Math.min(actionCount - 1, this.selectedIndex + delta));
		this.update();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.completed) {
			if (kb.matches(keyData, "tui.select.confirm") || kb.matches(keyData, "tui.select.cancel")) {
				this.options.onAction("done");
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.confirmingExit) {
				this.confirmingExit = false;
				this.selectedIndex = 0;
				this.update();
			} else {
				this.confirmingExit = true;
				this.selectedIndex = 0;
				this.update();
			}
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			if (this.confirmingExit) {
				if (this.selectedIndex === 1) this.options.onAction("exit");
				else {
					this.confirmingExit = false;
					this.selectedIndex = 0;
					this.update();
				}
				return;
			}
			const action = this.actions[this.selectedIndex]?.action;
			if (action === "finish") {
				this.completed = true;
				this.update();
			} else if (action) {
				this.options.onAction(action);
			}
		}
	}
}
