<p align="center">
  <a href="https://github.com/leolastforce/chalice">
    <img alt="Chalice" src="./assets/ChaliceLogo.png" width="950">
  </a>
</p>

<p align="center">
  <a href="https://discord.gg/4Ks7m95EKP"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Chalice Discord"></a>
  <a href="https://www.npmjs.com/package/@leolastforce/chalice"><img src="https://img.shields.io/npm/v/@leolastforce/chalice?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
</p>

<div align="center">
  An opinionated, lightweight coding agent built for control, token efficiency, and customizability.
  <br>
  <br>
</div>

<div align="center">
  <table>
    <tr>
      <td align="center">
        <img src="./assets/chalice-showcase.gif"
             alt="Chalice Showcase"
             width="700">
      </td>
    </tr>
  </table>
</div>

<br>

- **Control**: Permission modes, planning, undo/redo, steering.
- **Token efficiency**: Semantic search, anchor-based editing, output truncation.
- **Workflow**: Focus on prompt → edit → answer rather than unnecessary autonomy or long lived goals.
- **Looks Customizability**: Themes, layouts, status bars, onboarding, and appearance settings.
- **Based on Pi**: The extension system works seamlessly! 

# Installation

Install with npm:
```npm install -g @leolastforce/chalice@1.0.6```

If you are an extraterrestrial being, please use telepathy instead:
```gloop glop glip gloop gloop chalice```

Boot chalice up by running ```chalice``` in your preferred terminal! (sorry for making it hard)

# Features
> Chalice uses the Pi provider system, which has 30~ different providers cleanly supported.

## Main Features
> Features most agent harnesses don't have
- Semantic File Indexing
- Undo / Redo tracking system for files
- Permission Modes:
  - **Build** - The agent has full permissions inside a sandbox in the current directory
  - **Plan** - The agent defines a plan and prompts you to accept the plan after you review it, you can then accept the plan for the agent to execute.
  - **Ask** - Asks you to confirm each bash command, edit, and write. Approved in-project bash runs inside the sandbox
  - **YOLO** - The agent has no restrictions at all, it's build mode except it can access exterior directories without restrictions. "fuck it we ball"
- Test methods tracking

## General Features
- Sub-agents
- Sessions
- Web Search Tools
- Steering
- Anchor Based Editing
- TODOs
- MCP Server Support
- Clean onboarding

## Secondary features
- The UI looks good (I hope)
- Appearance Customisation:
  - Themes
  - Status bar modes & Layouts
  - Status bar Position & optional line border setting
  - Welcome banner modes (Minimal, Full, none (/settings -> Welcome Banner type))
  - Displayed status bar stats visibility (/settings -> Below input bar stats)
  - Input indicator
- Username reference - What the agents and other features refer to you as (disable in /settings)
- Tool output truncation, anchor based editing, semantic searching, etc.. All contribute to optimising token usage - alongside the Pi agent loop

## Tools
> Tools available in YOLO mode

| Name | Description |
| --- | --- |
| read | Read a text file |
| write | Create or overwrite a file |
| replace | Replace lines in a text file by anchor |
| insert | Insert lines into a text file by anchor |
| undo_last_change | Undo the last edit on a file |
| bash | Run a shell command |
| find | List files by path and name |
| anchor_grep | Search files with ripgrep |
| semantic_code_search | Search the codebase by meaning |
| list_code_tags | List declared code tags |
| todo | Manage a todo list |
| web_search | Search the live web |
| web_fetch | Fetch a web page or PDF as text |
| request_network_access | Request network access for specified domains |
| show_plan | Render a plan Markdown file for review |
| mcp | Install, inspect, and call MCP servers |
| mcpScript | Batch several MCP tool calls in one JavaScript request |
| multi_tool_use.parallel | Run independent tools in parallel |
| subagent | Delegate work to a child agent |
| subagents_enable | Enable subagent delegation and management tools |
| bg_wait | Wait for background work to finish |
| subagent_supervisor | Reply to child agent requests |

# Credits

Chalice is made by leolastforce
Chalice is based on Pi and several other user repos, see [CREDITS.md](CREDITS.md)

# Supporting
- ... Starring the repo and sharing it with your friends is greatly (somewhat) appreciated, suggestions are amazing, but the best thing you can do: Is simply use Chalice! (... I didn't know what else to say, but yea I would go crazy if I saw someone use Chalice that I didn't know lol)
- Thanks for reading the README, but in the future, probably don't go around reading every single README just because it's called README and you're trying to be nice, but... We do need more people like you! 

Have a good day, -Leo out

# Documentation
> The fun boring stuff made fun

# Undo / Redo

## Overview on how Undo / Redo works

Undo and redo works by tracking user prompt cycles, when a cycle changes files, a snapshot is saved about which files belong to that conversation turn.
- When in a git repository, it tracks changes and normal files that are not ignored, which includes changes made by shell commands, which is the main differentiator.
- When it ISN'T in a git repository, Chalice only snapshots paths that were directly used by Chalice's edit tools; edit, write, which means shell created files and edits are not covered, you will get a notice though.

TLDR: It works with the shadow git repo method.

## Dirty guard

Before restoring, there is a check for non snapshotted changes that could be overwritten, if there are, the redo is blocked.

## Session Tree

A relatively simple thing to account for if you've used Pi in the past to get in your head: Undo / Redo are linked to the session tree (/tree or Esc + Esc quickly), meaning _moving to another point in the thread restores the workspace state snapshot associated with it_

# Test Methods

## Overview on how test methods works
Test Methods lets a project describe how its tests should be run, then gives those instructions to Chalice before it starts working on a prompt.

Create a TESTMETHODS.md file in the project's root

> Example:
```md
Before considering a feature complete:
- Run the unit tests.
- Run the formatter.
- Run the type checker.
```

## Session control

Test-method prompting is enabled by default when `TESTMETHODS.md` contains content. Use the command below to control it for the current session:

```text
/dotestmethods       toggle prompting
/dotestmethods true  enable prompting
/dotestmethods false disable prompting
```

The setting is stored in the session tree, so it follows the current session history. If `TESTMETHODS.md` is missing or empty, no test-method instructions are added (grass is green).

## Why use this?
The main incentive is that you can enable and disable the instructions unlike AGENTS.md without really having to explicitly tell the agent to or not to run tests with whatever contents TESTMETHODS.md contains.

It isn't inherently a strong feature, more so quality of life, nonetheless, it doesn't hurt to just leave it blank! (that's what /goal said and look what happened to it lol)

TLDR: TESTMETHODS.md separates optional test-execution instructions from general project guidance.

# Subagents

## Overview on how subagents works
A subagent is a separate Chalice instance which is given a specific task, probably by the main agent. The session you are currently in is in charge of it, and chooses whether to delegate, what task to give the child, and of course what to do with the result.

## "Agents"
An agent is literally a markdown file which has a system prompt and settings (optional), for example it's name, tools, and model.

These are the built in subagents meant for common jobs:
- The "scout" - Maps relevant files, code paths, and risks
- The "worker" - Literally just an implementer for assigned changes
- The "reviewer" - It's in the name (checks changes and reports problems)
- The "oracle" - Peer pressure final boss, challenges whatever is assigned (for example a plan) without editing files
- The "researcher" - Gathers external information, which needs web tools available in the child session (the child being the subagent)

## Workflows
So for example, you are making a change that needs more than one pass, a pattern could be: 

clarify then to scout then to worker then to reviewers then to worker

> The parent can do independent tasks at the same time, or also wait for a result before starting the next. Worktree isolation could give writing children seperate Git worktrees when changes in parallel should not share the same files, which I like to do!

## Background work
Subagents running in the background _continue even after the main agent finishes a prompt cycle / returns control_. They report their status and result back to the session that started them, so you can inspect a run or its transcript, send feedback / guidance, or simply just stop it.

## Something to note
Agents using... subagents is not automatic and I hope you know that, asking for subagents or giving them a task several steps, does not mean the main agent should launch one, so.. You should give the main agent clear instructions when you DO want it to delegate.

_Example_
> Have a scout inspect the change, ask worker to implement it, then have reviewer check the result

Conclusion: Subagents make you feel productive and cool and they are also useful so... Why not use them? (but make sure to actually use them when they are.. Useful, otherwise it's counter-intuitive)

## Missions
A mission is a record that is saved for a piece of delegated work. It gives related runs one place to live, so you can basically see _what the work was for, which runs were part of it, and what they produced_.

For example, you ask Chalice to like I don't know investigate a bug, implement a fix, and review it, that / those runs can belong to the same "mission", later, you can look up the mission to find the runs and their results instead of piecing them together from old chat messages.

A mission (can) also keep decisions and delivery links, for example pull requests or automated test or build results. Saving a "mission" does not mean the work will continue by itself and if a run stops or needs a decision, you need to resume it or respond.

TLDR: Missions are project management layer for subagents

# Semantic File Indexing

## What does semantic file indexing refer to in Chalice?
Semantic indexing helps the agent find code by describing what it does, in scenarios where the agent might not know the exact filename or identifier. For example, the agent might search "the code that retries failed embedding requests" instead of guessing the function name.

It's an alternative option to the ordinary search tools, it's tool call is semantic_code_search.

## How the index is built
When indexing is turned on, Chalice finds eligible projects files (see ## Which files are ignored for details), divides their content into "chunks", and sends each "chunk" to your configured embedding provider. 

When the search happens, Chalice embeds that query with same provider and looks for chunks with similar vectors. The file path, line range, and short code snippet is then returned as the result from the tool.

> Supported providers for semantic file as of right now (feel free to request more in a github issue!):
- Voyage AI (Reccomended, considered to have the greatest indexing models overall.)
- Openrouter (Generally perfectly fine and easy to set up)
- Local OpenAI-compatible embeddings (See ## OpenAI-compatible embeddings provider information subcategory)

## Which files are indexed and how to explicitly ignore files?
Each file that is included in the list below will not be indexed:

- Git's ignore rules when the project is a Git repo
- Entries in ```.indexignore```
- Entries in ```.contextignore```
- Configured excluded directories, such as ```node_modules``` and ```dist```

Additionally, it is checked if a file is binary, oversized (768 KiB+), and files matching known secret filename or content patterns for privacy. Change this with /index config

## How does index updating work?
Alright so, you've indexed your project, and now you've added new changes, now what?

When indexing is enabled, a file watcher will update the index as files change. Small changes can be embedded automatically, but if many changes arrive together (common), the automatic embedding pauses and you will be notified to run /index update

## Tags
Tags let you filter semantic search results by project area without rebuilding the index.

```.index_tag``` files let you label directories so that you can filter search results. The tags are manually inputed and inherited from parent directories. Okay an example: a test tag in ```test/.index_tag``` applies to files under ```tests/```

Use ```exclude_tags``` to in turn remove tagged areas while still leaving untagged files eligible, use ```include_tags``` to restrict results to files with at least one listed tag.

Tag changes take effect at the tool call time so you do not need to reindex. Run /index tags to see tags

## Costs and provider
You will get an estimated token cost with the configured provider so you don't get caught offguard, for most repos, expect this to be dirt cheap, typically landing between 0.01 to 0.05$. If the provider remote's pricing is unknown, you'll just get an estimate in tokens instead.

The first time you enable indexing with a remote provider, Chalice will ask you to confirm that the code chunks can be sent to that provider, and local embeddings do not require an API key or send requests to a remote provider, so you will not be prompted. This is just a light privacy check <3

## OpenAI-compatible embeddings provider information
I wanted to clarify on how the OpenAI-compatible provider worked as an option since it doesn't work out of the box.

The local option connects to an embedding server running on your machine. It uses an OpenAI-compatible embeddings API, so the server needs to accept `POST /v1/embeddings` requests and return embedding vectors in the OpenAI response format. So, Chalice uses the server, and doesn't download or do anything from you

The default endpoint is `http://127.0.0.1:11434/v1/embeddings` with the model `nomic-embed-text`, which works with a compatible local setup such as Ollama. Make sure the server is running and the model is available before indexing. You can change the endpoint and model in `/index config`.

T
