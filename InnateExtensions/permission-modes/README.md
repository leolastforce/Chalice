# @georgedong32/permission-modes

[![npm version](https://img.shields.io/npm/v/@georgedong32/permission-modes)](https://www.npmjs.com/package/@georgedong32/permission-modes)
[![License](https://img.shields.io/npm/l/@georgedong32/permission-modes)](LICENSE)

Claude-Code-style **permission modes** for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Four modes, cycled with **Alt+M**, that control how tool calls get approved. v2.0.0 adds **bypass**, a built-in **auto classifier**, **plan.md** file driver, and system-prompt anchor injection.

## Modes

| Mode | edit / write | reads outside cwd | bash | notes |
|---|---|---|---|---|
| **ask** `●` | prompt (`Allow` / `Allow all → bypass` / `Block`) | prompt | mutating commands prompt | one-line reminder on mode switch |
| **plan** `⏸` | only `plan.md` | allowed | read-only allowlist | plan file at `.pi/projects/<id>/plan.md` |
| **auto** `▶` | cwd writes auto; risky ops → classifier/blacklist | auto | tiered | optional classifier in `permission-modes.json` |
| **bypass** `⚡` | all auto-approved (tracked outside cwd) | auto | auto | security reminder on switch + compact |

**Cycle (Alt+M):** ask → plan → auto → bypass → ask.

When there is no interactive UI (`pi -p`, `--mode json`), anything that would prompt is **blocked** instead of silently allowed — unless the process is a **pi-subagents child** with `PI_SUBAGENT_PARENT_SESSION` set; then the ask is forwarded to the parent session UI (see below).

### Subagent permission forwarding

Headless subagent children cannot show `ctx.ui.select`. With **pi-subagents**, the root interactive session exports `PI_SUBAGENT_PARENT_SESSION`, and children inherit it (spawn also passes the direct parent session id).

When permission-modes would prompt and `!ctx.hasUI`:

1. If `PI_SUBAGENT_PARENT_SESSION` is unset → **fail-closed block** (same as before).
2. If set → write a request under  
   `~/.pi/agent/sessions/permission-modes-forwarding/sessions/<parentSessionId>/requests/`  
   and poll for a response (250ms interval, 10 minute timeout).
3. The parent session (has UI, not `PI_SUBAGENT_CHILD=1`) runs a poller that shows  
   Allow / Allow always (this project) / Allow always (global) / Block.  
   **Allow always** rules are written using the request’s **child `cwd`**, not the parent cwd.
4. Timeout, cancel, or Block → child gets a block reason (never silently allowed).

**Limits:** nested subagents whose direct parent has no UI still time out and deny (this package does not rewrite the target to the root session). This inbox path is **not** shared with `@gotgenes/pi-permission-system` (`permission-forwarding/`); the two can coexist without double-handling.

### Subagent inherits parent mode

The interactive session writes `PERMISSION_MODES_INHERITED_MODE` (`ask` | `plan` | `auto` | `bypass`) into the process environment whenever the mode changes (and again on each `before_agent_start`). pi-subagents merges `process.env` into child spawns (and passes `--permission-mode` when that env is set), so headless children start in the **same mode** as the parent (e.g. parent bypass → child auto-approves; no approval popups).

### Auto classifier (optional)

Configure `~/.pi/agent/permission-modes.json`:

```json
{
  "classifier": {
    "enabled": false,
    "model": "anthropic/claude-haiku-4-5",
    "timeoutMs": 8000
  }
}
```

Uses `completeSimple` from `@earendil-works/pi-ai/compat` with credentials from pi's `modelRegistry` — all built-in provider APIs (Anthropic, OpenAI, Azure, etc.) are supported automatically.

### Permission rules (v2.1.0, CC-compatible)

Configure **allow / deny / ask** rules in Claude Code syntax (`Tool` or `Tool(specifier)`). Rules merge across scopes; evaluation order is **deny → ask → allow** (deny cannot be overridden).

| Scope | Path |
|---|---|
| Global | `~/.pi/agent/permission-modes.json` → `permissions` block |
| Project (shareable) | `<cwd>/.pi/projects/<id>/permissions.json` |
| Project local | `<cwd>/.pi/projects/<id>/permissions.local.json` (personal; add to `.gitignore`) |

Example global config:

```json
{
  "classifier": { "enabled": false },
  "permissions": {
    "allow": ["Bash(npm run test *)", "Read(~/.zshrc)"],
    "deny": ["Bash(curl *)", "Read(./.env)", "Read(./.git/**)"],
    "ask": ["Bash(npm install *)"]
  }
}
```

When a tool call would prompt, you can choose **Allow always (this project)** or **Allow always (global)** to persist an allow rule. Use `/permissions` to list the merged rule set.

## Model profiles (v1.1.1)

Define named profiles in `~/.pi/agent/model-profiles.json` mapping each mode to a **model + effort** pair. Each mode entry can be a bare model string, or a `ModeConfig` object:

```json
{
  "active": "default",
  "default": {
    "ask":  { "model": "anthropic/claude-opus-4-5", "effort": "high" },
    "plan": { "model": "anthropic/claude-opus-4-5", "effort": "xhigh" },
    "auto": { "model": "anthropic/claude-haiku-4-5", "effort": "low" },
    "bypass": { "model": "anthropic/claude-haiku-4-5", "effort": "medium" }
  },
  "fast": {
    "ask":  "anthropic/claude-haiku-4-5:low",
    "plan": "anthropic/claude-haiku-4-5:low",
    "auto": "anthropic/claude-haiku-4-5:off"
  }
}
```

- **Model ID**: `"provider/model"`, or `"provider/model:effort"` (the `:effort` suffix sets thinking after the switch).
- **`ModeConfig.effort`**: explicit field (`off` | `minimal` | `low` | `medium` | `high` | `xhigh`). Wins over a `:suffix` on the same entry. If neither is set, defaults to **`medium`**.
- When the mode changes, the extension calls `pi.setModel()` then `pi.setThinkingLevel()`. Unknown levels are skipped with a notify warning.
- The footer shows `profile:<name> · model/thinking` when a profile is active.

If the file doesn't exist on first install, the extension creates it for you (pre-filled with the user's default model from `~/.pi/agent/settings.json` when available).

**Why a separate `model-profiles.json` and not pi's built-in `models.json`?** Pi uses `~/.pi/agent/models.json` for custom provider definitions; using a different filename avoids format conflict.

## Commands, shortcut, flag

| Kind | Name | Behavior |
|---|---|---|
| Command | `/ask`, `/plan`, `/auto` | switch to that mode (`/default` also works as alias) |
| Command | `/mode [name]` | set the given mode, or pick from a list |
| Command | `/auto-depth <n>` | cap auto-mode follow-ups (`0` = unlimited; default 20) |
| Command | `/model-profile` | show selector of available profiles |
| Command | `/model-profile <name>` | activate the named profile (also `/model-profile list` to print them) |
| Shortcut | `Alt+M` | cycle modes |
| Shortcut | `Alt+T` | cycle thinking level (off → minimal → low → medium → high → xhigh) |
| Shortcut | `Alt+I` | cycle model profile (next profile from `~/.pi/agent/model-profiles.json`; re-applies the model for the current mode) |
| Command | `/permissions` | list merged allow/deny/ask rules |
| Command | `/outside-writes` | list tracked outside-cwd writes (read-only) |
| Command | `/undo-outside-writes` | restore outside-cwd writes (selector, `all`, or `--list`) |
| Flag | `--permission-mode <name>` | start in a mode (accepts `ask`, `plan`, `auto`, or `default` as alias; default `ask`) |
| Flag | `--model-profile <name>` | start with a named profile activated |

> The start-mode flag is `--permission-mode` (not `--mode`) because pi already has a built-in `--mode` for output format (text/json/rpc).

### Outside-cwd write tracking (v1.1.3)

In **auto mode**, `edit` and `write` calls to paths outside the working directory are auto-approved — but each one is snapshotted to `<cwd>/.pi/projects/<project-id>/tmp/outside-writes/`. Use `/undo-outside-writes` to roll back:

- `/undo-outside-writes` — interactive selector (newest first)
- `/undo-outside-writes all` — restore all without prompting
- `/undo-outside-writes --list` — list only (alias for `/outside-writes`)
- `/outside-writes` — same as `--list`

Snapshots capture the file's pre-write content (or `null` if the file didn't exist). They persist across sessions until you undo them. The snapshot cap is 100 entries (oldest are evicted; you get a notification).

### Per-mode skill filtering (v1.1.4, fixed in v1.1.5)

When you're in **plan mode**, skills like `systematic-debugging` and `executing-plans` are irrelevant noise. Skill filtering lets you configure which skills get injected into the system prompt per mode — saving tokens and keeping the agent focused.

```json
{
  "active": "default",
  "default": {
    "ask": "anthropic/claude-sonnet-4-5",
    "plan": {
      "model": "anthropic/claude-sonnet-4-5",
      "skills": ["brainstorming", "writing-plans"]
    },
    "auto": "openai/gpt-4o"
  }
}
```

- `"skills": ["brainstorming", "writing-plans"]` — only these two skills appear in the system prompt when in plan mode.
- `"skills": ["*"]` or omitting `skills` entirely — allow all skills (default, no filtering).
- String shorthand (`"anthropic/claude-sonnet-4-5"`) still works — backward compatible.
- Skills can still be invoked manually via `/skill:name` if needed — filtering only controls which skills are pre-loaded into the agent's context.

**Resolution order:** Active profile → default profile → hardcoded defaults (`["*"]`). The `read` tool is always mandatory in tool filters (full tool filtering is planned for a future release).

### Plan mode flow

In plan mode the agent explores read-only and emits a numbered list under a `Plan:` header. On completion you choose:

- **Execute the plan** — switches to auto, restores edit/write, runs the steps; a `☐/☑` widget advances as the agent emits `[DONE:n]` tags, and you get **Plan Complete! ✓** at the end.
- **Stay in plan mode** — keep iterating.
- **Refine the plan** — opens an editor; your notes are sent back as a follow-up.

## UI

- A custom **adaptive footer** (v1.1.6): wide terminals show **cwd [git-branch] · context usage · profile/model** on line 1 and **mode** on line 2; narrow terminals reflow to two compact lines with truncation.
- **Context usage** in the footer shows `tokens/contextWindow percent` (e.g. `42k/200k 21.0%`; large counts use `M`).
- While the agent is streaming, the working indicator shows live **token / tok-s / cost / % context** stats; it reverts to the default loader when idle.
- Mode colors: ask = muted, plan = accent, auto = warning. The colored status pill was removed in v1.1.6 — mode is shown in the footer only.

Current mode, the auto-follow-up depth, and the active profile name **persist** across `/reload` and session resume.

## Install / run

```bash
# Install as a package (scoped npm name; or from a git remote / local path)
pi install npm:@georgedong32/permission-modes
pi list                                            # verify it loaded

# Or run it directly for a quick try (no install)
pi -e ./extensions/permission-modes/index.ts

# During development, hot-reload after edits
/reload
```

Auto-discovery also works: drop this folder at `~/.pi/agent/extensions/permission-modes/` (global) or `.pi/extensions/permission-modes/` (project) and pi loads `index.ts` automatically.

## Testing

```bash
npm test                # run all 189 tests (vitest)
npm run test:watch      # watch mode for development
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## Layout

```
permission-modes/             # @georgedong32/permission-modes
├── package.json              # pi manifest + npm package metadata
├── index.ts                  # main extension (default-exported factory)
├── profiles.ts               # NEW in v1.1.1: model-profile config helpers
├── profiles.test.ts          # NEW in v1.1.1: unit tests for profiles
├── utils.ts                  # bash allowlist + Plan: + [DONE:n] helpers
├── index.test.ts             # integration tests (vitest)
├── utils.test.ts             # unit tests (vitest)
├── vitest.config.ts          # vitest config
├── CHANGELOG.md              # release history
├── LICENSE                   # MIT
├── .gitignore                # excludes node_modules, lockfile, .pi/
└── docs/
    ├── PRD.md                # product requirements
    └── prompts/              # mode-specific prompt context
        ├── ask-mode-prompts.md
        ├── plan-mode-prompts.md
        └── auto-mode-prompts.md
```

Third-party deps: none. Peer dependencies (bundled by pi): `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`. The model is switched **only when the user opts in via `~/.pi/agent/model-profiles.json`** — without a profile config file, the model never changes and the extension behaves exactly as in v1.1.0.
