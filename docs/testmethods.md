# Overview on how test methods works
Test Methods lets a project describe how its tests should be run, then gives those instructions to Chalice before it starts working on a prompt.

Create a TESTMETHODS.md file in the project's root

> Example:
```md
Before considering a feature complete:
- Run the unit tests.
- Run the formatter.
- Run the type checker.
```

# Session control

Test-method prompting is enabled by default when `TESTMETHODS.md` contains content. Use the command below to control it for the current session:

```text
/dotestmethods       toggle prompting
/dotestmethods true  enable prompting
/dotestmethods false disable prompting
```

The setting is stored in the session tree, so it follows the current session history. If `TESTMETHODS.md` is missing or empty, no test-method instructions are added (grass is green).

# Why use this?
The main incentive is that you can enable and disable the instructions unlike AGENTS.md without really having to explicitly tell the agent to or not to run tests with whatever contents TESTMETHODS.md contains.

It isn't inherently a strong feature, more so quality of life, nonetheless, it doesn't hurt to just leave it blank! (that's what /goal said and look what happened to it lol)

TLDR: TESTMETHODS.md separates optional test-execution instructions from general project guidance.
