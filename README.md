<div align="center">

</div>

<p align="center">
  <a href="https://github.com/leolastforce/chalice">
    <img alt="Chalice logo" src="./assets/ChaliceFullLogo.png" width="950">
  </a>
</p>

<p align="center">
  <a href="https://discord.gg/4Ks7m95EKP"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Chalice Discord"></a>
</p>

Nowadays, a lot of mainstream agent harnesses are all going for autonomy / autonomous agentic workflows, while most people still stick to the prompt --> edit --> answer model.

Chalice isn't going for autonomy or an agentic workflow. It's going for the same typical prompt edit workflow, except _it's goal is to aid in passing implementation as cleanly as possible whilst still staying light token usage wise_

> 63% of technologists rarely or never let agents run on autopilot, and 68% prefer single agents setups. If I were to be considered a technologist, I would be part of that 68%.

# Installation
Boot chalice up by running ```chalice``` in your preferred terminal!

> Officially supported package managers: NPM

Install with npm:
```npm install -g @leolastforce/chalice@1.0.6```
> Install latest Chalice version with NPM

# Features
> Chalice uses the Pi provider system, which has 30~ different providers cleanly supported.

## Main Features
> What Makes Chalice different from a big chunk of other harnesses
- Semantic File Indexing
- Agent Modes: 
  - Build - The agent has full permissions in the current project directory
  - Plan - The agent defines a plan and prompts you to accept the plan after you review it, you can then accept the plan for the agent to execute.
  - Ask - Asks you to confirm each bash command, edit, and write. Approved in-project bash runs inside the sandbox
  - YOLO - The agent has no restrictions at all, it's build mode except it can access exterior directories without restrictions.
- Goal tracking (/goal)
- Undo / Redo tracking system for files
- Test method tracking (/testprompt or TESTMETHODS.md in project)

## General Features
- Sub-agents
- Sessions
- Web Search Tools
- Steering
- Anchor Based Editing
- TODOs
- MCP Server Support
- AGENTS.md context
- Clean on-boarding

## Secondary features
- Looks customisation:
  - Themes
  - Status bar modes & Layouts
  - Status bar Position & optional line border setting
  - Welcome banner modes (Minimal, Full, none (/settings -> Welcome Banner type))
  - Displayed status bar stats visibility (/settings -> Below input bar stats)
  - Input indicator
- Username reference - What the agents and other features refer to you as (disable in /settings)
- Tool output truncation, anchor based editing, semantic searching, etc.. All contribute to optimising token usage - alongside the Pi agent loop

## Some appearance configuration examples:

<p align="left">
  <a href="https://github.com/leolastforce/chalice">
    <img alt="Chalice logo" src="./assets/semicompactfullscreenrose.png" width="600">
  </a>
</p>
<p align="left">
  <a href="https://github.com/leolastforce/chalice">
    <img alt="Chalice logo" src="./assets/minimalisticblack.png" width="400">
  </a>
</p>
<p align="left">
  <a href="https://github.com/leolastforce/chalice">
    <img alt="Chalice logo" src="./assets/blacklightfullscreen.png" width="700">
  </a>
</p>

## Tools
> Tools in YOLO mode with full permissions (not including Mode specific tools)

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
Chalice uses Pi and several other user repos, see [CREDITS.md](CREDITS.md)
