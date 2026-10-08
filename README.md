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

Chalice isn't going for autonomy or an agentic workflow. It's going for the same typical prompt edit workflow, except _it's goal is to aid in passing implementation as cleanly as possible whilst not making it token heavy_

> 63% of technologists rarely or never let agents run on autopilot, and 68% prefer single agents setups. If I were to be considered a technologist, I would be part of that 68%.

# Installation

clone the repo, then: 

npm run install:global

to launch the app, run "chalice" anywhere (chalice --help for some parameter options but these are mostly the things that come with Pi)

# Features
> Chalice comes with 30~ different providers innately supported.

## Main Features
> What Makes Chalice different from a big chunk of other harnesses
- Semantic File Indexing
- Modes: press `Tab` to cycle through **Change** (default tools), **Think** (read-only tools), **Review** (all default tools except `edit` and `write`), and **Debug** (bug-fix mode).
- Goal tracking (/goal)
- Test method tracking (/testprompt or TESTMETHODS.md in project)

## General Features
- Git Interface via lazygit (Shift + G or /git)
- Sub-agents
- Sessions
- Web Search Tools
- Steering
- Anchor Based Editing
- TODOs
- MCP Server Support
- AGENTS.md context

## Secondary features
- Looks customisation:
  - Themes
  - Banner modes (Minimal, Full, none (/settings -> Welcome Banner type))
  - Displayed stats visiblity (/settings -> Below input bar stats)
- Username reference - What the agents and other features refer to you as (disable in /settings)

## Tools
> Tools in Change mode with full permissions

| Name | Description |
| --- | --- |
| read | Read a text file |
| bash | Run a shell command |
| write | Create or overwrite a file |
| mcpScript | Batch several MCP tool calls in one JavaScript request |
| mcp | Install, inspect, and call MCP servers |
| replace | Replace lines in a text file by anchor |
| insert | Insert lines into a text file by anchor |
| anchor_grep | Search files with ripgrep |
| find | List files by path and name |
| undo_last_change | Undo the last edit on a file |
| semantic_code_search | Search the codebase by meaning |
| list_code_tags | List declared code tags |
| todo | Manage a todo list |
| web_search | Search the live web |
| web_fetch | Fetch a web page or PDF as text |
| subagent | Delegate work to a child agent |
| bg_wait | Wait for background work to finish |
| subagent_supervisor | Reply to child agent requests |

# Credits

Chalice is made by leolastforce
Chalice uses Pi and several other user repos, see [CREDITS.md](CREDITS.md)
