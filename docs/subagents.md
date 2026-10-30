# Overview on how subagents works
A subagent is a separate Chalice instance which is given a specific task, probably by the main agent. The session you are currently in is in charge of it, and chooses whether to delegate, what task to give the child, and of course what to do with the result.

# "Agents"
An agent is literally a markdown file which has a system prompt and settings (optional), for example it's name, tools, and model.

These are the built in subagents meant for common jobs:
- The "scout" - Maps relevant files, code paths, and risks
- The "worker" - Literally just an implementer for assigned changes
- The "reviewer" - It's in the name (checks changes and reports problems)
- The "oracle" - Peer pressure final boss, challenges whatever is assigned (for example a plan) without editing files
- The "researcher" - Gathers external information, which needs web tools available in the child session (the child being the subagent)

# Workflows
So for example, you are making a change that needs more than one pass, a pattern could be: 

clarify then to scout then to worker then to reviewers then to worker

> The parent can do independent tasks at the same time, or also wait for a result before starting the next. Worktree isolation could give writing children seperate Git worktrees when changes in parallel should not share the same files, which I like to do!

# Background work
Subagents running in the background _continue even after the main agent finishes a prompt cycle / returns control_. They report their status and result back to the session that started them, so you can inspect a run or its transcript, send feedback / guidance, or simply just stop it.

# Something to note
Agents using... subagents is not automatic and I hope you know that, asking for subagents or giving them a task several steps, does not mean the main agent should launch one, so.. You should give the main agent clear instructions when you DO want it to delegate.

_Example_
> Have a scout inspect the change, ask worker to implement it, then have reviewer check the result

Conclusion: Subagents make you feel productive and cool and they are also useful so... Why not use them? (but make sure to actually use them when they are.. Useful, otherwise it's counter-intuitive)

# Missions
A mission is a record that is saved for a piece of delegated work. It gives related runs one place to live, so you can basically see _what the work was for, which runs were part of it, and what they produced_.

For example, you ask Chalice to like I don't know investigate a bug, implement a fix, and review it, that / those runs can belong to the same "mission", later, you can look up the mission to find the runs and their results instead of piecing them together from old chat messages.

A mission (can) also keep decisions and delivery links, for example pull requests or automated test or build results. Saving a "mission" does not mean the work will continue by itself and if a run stops or needs a decision, you need to resume it or respond.

TLDR: Missions are project management layer for subagents
