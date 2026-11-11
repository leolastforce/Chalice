## Overview on the conversation search tool
The conversation search tool is a tool to let Chalice search through other conversations based on keywords, useful when going in par with the memory tool. Basically this is another tool to interconnect the threads together.

Something pretty important to note is that it is specific to the current project by default, but it is possible to search globally with appropriate parameter.

## How does the conversation search tool tool work
The tool is to be called with a search query, then "Chalice":

1. Finds eligible local session files (Filtered: Current session, forked sessions, private mode sessions).
2. The query is then matched, the results are ranked by coverage, the phrase match, and how close matching words are to one-another.
3. Returns the matching messages along with the surrounding context (the excerpt), a reference the agent can use to read a larger excerpt

> Excerpt is a word half of us don't know, and it means "An excerpt is a short part, passage, or quote taken from a longer written work, speech, film, or piece of music."

## Limits to the search tool
 - 5 seconds for discovering and scanning session files.
 - 64 MiB of session files scanned per search.
 - 8 MiB maximum per session file
 - 1 MiB maximum per line in a session file; files with larger lines are skipped.
 - 10,000 session files maximum during discovery.
 - 16,000 JSON bytes maximum in the returned result.
 - 5 results by default, configurable by the agent up to 50.

If a search's scan limit is reached, the tool returns that the search was incomplete, no results.

## Parameters to the conversation search tool the agent can call
**The "action" field**
The tool is called with an action either being search or read.
- Search is the thing this documentation has mostly been covering and is self explanatory
- Read is the action to call to get the larger excerpt (excerpt counter: 3x) from a previous search action result

**The "limit" field**
It is simply the maximum number of search results returned, the max is 50, if left out, the default is 5 results

**The "query" field**
It's the query field

**The "after" and "before" fields**
Start date / time for a search and it's in ISO format. These are both two different fields by the way.

**The "scope" field**
By default the scope is to the sessions in the current project, the agent can set it to "all" for cross project searches.

**The "reference" field**
Required if the action is "read", when the agent finds a conversation from the search action, it gets a reference to the matching excerpt (excerpt counter: 4x). It can then pass that reference back to read more of the conversation around the excerpt (excerpt counter: 5x)
