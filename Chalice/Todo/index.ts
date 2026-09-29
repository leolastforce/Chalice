/**
 * Todo Extension - Demonstrates state management via session entries
 *
 * This extension:
 * - Registers a `todo` tool for the LLM to manage todos
 * - Registers a `/todos` command for users to view the list
 *
 * State is stored in session entries (not external files), which allows proper
 * branching - when you branch, the todo state is automatically correct for that
 * point in history, including completed-task cleanup between turns.

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

interface TodoState {
	todos: Todo[];
	nextId: number;
}

const TODO_STATE_ENTRY = "todo-state";

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});


function renderTodoTree(todos: Todo[], theme: Theme, width?: number): string[] {
	return todos.map((todo, index) => {
		const branch = index === todos.length - 1 ? "└──" : "├──";
		const status = todo.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
		const text = todo.done ? theme.fg("dim", todo.text) : theme.fg("text", todo.text);
		const line = `  ${branch} ${text} ${status}`;
		return width === undefined ? line : truncateToWidth(line, width);
	});
}
/**
 * UI component for the /todos command
 */
class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("accent", "TODOs")}`, width));
			lines.push("");
			lines.push(truncateToWidth(`  └── ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const done = this.todos.filter((todo) => todo.done).length;
			const total = this.todos.length;
			const title = th.fg("accent", "TODOs");
			const progress = th.fg("muted", `(${done}/${total} completed)`);
			lines.push(truncateToWidth(`  ${title} ${progress}`, width));
			lines.push("");
			lines.push(...renderTodoTree(this.todos, th, width));
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;

	const updateTodoWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (todos.length === 0) {
			ctx.ui.setWidget("todo-status", undefined);
			return;
		}

		const open = todos.filter((todo) => !todo.done).length;
		const done = todos.length - open;
		const title = ctx.ui.theme.fg("accent", "TODOs");
		const progress = ctx.ui.theme.fg("muted", `(${done}/${todos.length} completed)`);
		ctx.ui.setWidget("todo-status", [`${title} ${progress}`, ...renderTodoTree(todos, ctx.ui.theme)], { placement: "aboveEditor" });
	};
	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY) {
				const state = entry.data as TodoState | undefined;
				if (state) {
					todos = state.todos;
					nextId = state.nextId;
				}
				continue;
			}
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}
		updateTodoWidget(ctx);
	};

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	pi.on("turn_end", async (event, ctx) => {
		if (event.message.role !== "assistant" || (event.message.stopReason !== "stop" && event.message.stopReason !== "length")) {
			return;
		}
		if (!todos.some((todo) => todo.done)) return;

		todos = todos.filter((todo) => !todo.done);
		if (todos.length === 0) nextId = 1;
		pi.appendEntry<TodoState>(TODO_STATE_ENTRY, { todos: [...todos], nextId });
		updateTodoWidget(ctx);
	});

	// Register the todo tool for the LLM
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, done: false };
					todos.push(newTodo);
					updateTodoWidget(ctx);
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "toggle",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					todo.done = !todo.done;
					updateTodoWidget(ctx);
					return {
						content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					updateTodoWidget(ctx);
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(`${theme.fg("accent", "TODOs")}\n└── ${theme.fg("dim", "No todos")}`, 0, 0);
					}
					const done = todoList.filter((todo) => todo.done).length;
					let listText = `${theme.fg("accent", "TODOs")} ${theme.fg("muted", `(${done}/${todoList.length} completed)`)}`;
					const display = expanded ? todoList : todoList.slice(0, 5);
					const hasMore = !expanded && todoList.length > display.length;
					display.forEach((todo, index) => {
						const branch = index === display.length - 1 && !hasMore ? "└──" : "├──";
						const check = todo.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = todo.done ? theme.fg("dim", todo.text) : theme.fg("muted", todo.text);
						listText += `\n${branch} ${itemText} ${check}`;
					});
					if (hasMore) {
						listText += `\n└── ${theme.fg("dim", `... ${todoList.length - display.length} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	// Register the /todos command for users
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
