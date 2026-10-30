# Overview on how Undo / Redo works

Undo and redo works by tracking user prompt cycles, when a cycle changes files, a snapshot is saved about which files belong to that conversation turn.
- When in a git repository, it tracks changes and normal files that are not ignored, which includes changes made by shell commands, which is the main differentiator.
- When it ISN'T in a git repository, Chalice only snapshots paths that were directly used by Chalice's edit tools; edit, write, which means shell created files and edits are not covered, you will get a notice though.

TLDR: It works with the shadow git repo method.

# Dirty guard

Before restoring, there is a check for non snapshotted changes that could be overwritten, if there are, the redo is blocked.

# Session Tree

A relatively simple thing to account for if you've used Pi in the past to get in your head: Undo / Redo are linked to the session tree (/tree or Esc + Esc quickly), meaning _moving to another point in the thread restores the workspace state snapshot associated with it_
