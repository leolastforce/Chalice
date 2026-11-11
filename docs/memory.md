## Overview on how memory works in chalice
Similar and inspired to the ChatGPT cross conversation memory feature, Chalice has a memory system to retain useful information like preferences personality and general facts, also having project directory specific memories for workflows

The agent is instructed to proactively save memories but I haven't dogfooded myself enough to see it consistently doing this without directly being asked to save something. For now ask it to save something when you need it to save something.

- Global memories are available everywhere, this is the main thing
- Project memories are specifically for the current working directory
> Memory saving is enabled by default, change it in /settings --> Chalice Memory Saving

## Where and how are the memories stored?
By default memories are stored locally in ~/.chalice/agent/memory/ using one JSON file per "memory"

Memories have these fields:
- Id - randomly generated UUID to identify the memory and it is also the file name(.json file extension)
- Text (the actual memory)
- Scope (Project vs global)
- Project (if scope is project, this is the hash of the directory's path)
- Created at - Creation date (format: year-month-dayofmonthThour:minute:seconds.millisecondsZ Z meaning UTC).
- Updated at - Last update date (format is the same as Created at)

An example memory looks like this:

```json
   {
     "id": "550e8400-e29b-41d4-a716-446655440000",
     "text": "Do this thing after that thing",
     "scope": "project",
     "project": "a-sha256-hash-of-the-working-directory-path",
     "createdAt": "2026-07-20T12:00:00.000Z",
     "updatedAt": "2026-07-20T12:00:00.000Z"
   }
 ```

## The /memory command and arguments
- /memory - lists the memories and show which are included in context
- /memory delete <id> - Delete memory by id
- /memory private on/off - Stop or let chalice from using saved memories in model requests for the current session, when it's on the agent can't use the memory tool AND the search past conversations tool.

> Regarding private mode, if it was enabled at any point, that session is excluded from future
   conversation-history searches, even AFTER it’s turned off. Also private mode isn't the incognito of coding agent it still saves past the session... Wait that could be a smart concept though? make an issue people make an issue :sob:

## How memories reach the model and limits
- The limit to what memories reach the model is either 40 different memory entries or 16,000 serialized JSON bytes. 
- Priority for memories is given to project scope memories, and, within each scope, the most recently updated memories take priority
