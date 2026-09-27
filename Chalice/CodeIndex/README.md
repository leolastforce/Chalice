# pi-code-index

Semantic code search extension for pi. Chunks source files, embeds them via a configurable
embedding provider, and exposes a `semantic_code_search` tool that lets the agent find code by
intent rather than by exact keywords.

## Install

```bash
pi install git:github.com/HCAHOI/pi-code-index
# or try it for one run without installing:
pi -e git:github.com/HCAHOI/pi-code-index
```

On install pi runs `npm install`, which pulls native dependencies (LanceDB,
tree-sitter wasms). First run downloads the embedding model / calls the
configured embedding provider — see Quick start. Requires Node ≥ 18.

## Quick start

```
/index on        # enable and build the index (prompts for cost confirmation)
/index status    # show file/chunk counts and config
```

## Subcommands

| Command | Description |
|---|---|
| `/index status` | Show index state, file/chunk counts, provider, and config |
| `/index on` | Enable indexing for the current project; builds the index if none exists |
| `/index off` | Disable indexing and stop the file watcher |
| `/index update` | Incremental sync — removes excluded/deleted chunks (free), embeds new/changed files (with cost confirmation) |
| `/index reindex` | Full rebuild from scratch (always confirms cost before proceeding) |
| `/index clear` | Wipe the index without disabling |
| `/index config` | Open the interactive settings wizard |
| `/index tags` | List all tags declared in `.index_tag` files (read-only, no reindex needed) |
| `/index help` | Show subcommand and ignore-layer reference |

## Ignore layers

Files are included in the index only if they pass **all** of the following layers, evaluated in
order from most to least authoritative:

1. **git** (git repo only) — git's own ignore machinery covers four sub-layers automatically:
   - `.gitignore` at the repo root
   - Nested `.gitignore` files in subdirectories
   - Global excludes (`core.excludesFile`, typically `~/.config/git/ignore`)
   - Repo-local excludes (`.git/info/exclude`)
2. **`.indexignore`** — project-local extra excludes, applied on top of git. Add paths here to
   narrow what gets indexed without touching git ignore rules.
3. **`.contextignore`** — shared context exclusions (read by other pi context tools as well).
4. **`excludeDirs` config** — built-in directory exclusions (`node_modules`, `dist`, `.git`, etc.).
5. **Content and secret filters** — all remaining regular files are discovered, but binary files, files over `maxFileBytes`, files matching secret basename patterns (`.env*`, `*.pem`, `id_rsa`, etc.), and files containing known secret-content patterns are skipped.

Non-git projects fall back to fast-glob + the `ignore` package reading the root `.gitignore`
only (nested `.gitignore` and global excludes are not available in this mode).

### `.indexignore` format

Same syntax as `.gitignore`:

```
# ignore a noisy data directory
fixtures/large-dataset/

# ignore generated files
src/generated/
*.pb.go
```

### `.contextignore` format

Same syntax as `.gitignore`. Shared with other context tools — prefer `.indexignore` for
index-specific exclusions.

## Tag filtering

Tag filtering lets you include or exclude groups of source files from a `semantic_code_search`
query **without touching the index**. Tags are 100% manually declared — no auto-tagging is ever
applied.

### `.index_tag` format

Place a file named `.index_tag` in any directory. Lines starting with `#` are comments; all other
content is split by commas and whitespace into tag tokens. Each token is normalized to lowercase,
trimmed, and stripped of any character outside `[a-z0-9_-]` (invalid tokens are silently dropped).

```
# Mark this directory as test code
test, integration
```

### Inheritance (union, declaration-only)

A file's effective tag set is the **union** of all `.index_tag` files found in its directory and
every ancestor directory up to the project root. Tags only accumulate — deeper directories add
tags, never remove them. There is no negation syntax in v1.

Example tree:

```
project/
  .index_tag          ← "core"
  src/
    .index_tag        ← "src"
    utils/
      helper.ts       ← effective tags: core, src
  tests/
    .index_tag        ← "test"
    unit/
      foo.test.ts     ← effective tags: core, test
```

### Query parameters

Pass `include_tags` and/or `exclude_tags` to `semantic_code_search`:

| Parameter | Semantics |
|---|---|
| `exclude_tags: ["test", "docs"]` | Drop any result whose tags contain **any** listed tag. Files with no tags are **not** affected. |
| `include_tags: ["core"]` | Keep only results whose tags contain **any** listed tag. Files with no tags are **excluded**. |
| Both omitted | No tag filtering — behaviour identical to before this feature. |

**Key design properties (important):**

- **Pure declaration, zero heuristics.** Tags come exclusively from `.index_tag` files. No
  path-based guessing (no automatic `test` or `docs` tags).
- **Computed at query time, never stored in the index.** Changing or adding a `.index_tag` file
  takes effect on the next query — **no reindex required**.
- **`exclude_tags` is the primary tool.** Use it to filter out test/docs/generated areas while
  leaving all untagged files reachable. Use `include_tags` only when you want a strict whitelist
  and are comfortable that untagged files will be excluded.

### Discovery

#### `list_code_tags` tool (recommended)

Call the `list_code_tags` tool to discover all tags in the project before deciding whether to
filter. It reports — without reading file contents — the number of indexed files each tag covers,
a one-line description from the `.index_tag` comment, and the directories that declare the tag:

```
Tags declared in this project (.index_tag files):

  test    — end-to-end benchmark tests                        (142 files · 18%)
            declared in: tests/, demo/gantt_viewer/tests/
  core    — core scheduling engine                            (610 files · 76%)
            declared in: src/
  (untagged: 8 files · 1% — excluded by include_tags)

Filter semantic_code_search:
  exclude_tags: ["test"]            skip tagged areas (untagged unaffected)
  include_tags: ["core","harness"]  whitelist: keep files matching ANY (untagged excluded)
```

If no `.index_tag` files exist yet, the tool shows an empty-state message that teaches the format.

#### `/index tags` command

Same information as the tool, available from the command palette:

```
/index tags    # list declared tags with file counts and declaring directories
```

#### Inline hint in `semantic_code_search`

When tag filtering is not active but the project has `.index_tag` files and at least one result
belongs to a tagged area, `semantic_code_search` automatically appends a one-line hint:

```
ℹ tags available: core(76%) · test(18%) · vendor(5%) — pass include_tags/exclude_tags to filter
```

This surfaces the tag option at the moment it is most useful, without requiring the agent to
remember to check first. The hint is suppressed when all results are untagged (to avoid noise on
unrelated queries).

## Cost model

| Operation | Cost | Trigger |
|---|---|---|
| Delete chunks (file excluded or deleted) | Free | Automatic (watcher) or `/index update` |
| Embed changed/new files (few) | Small | Watcher auto-incremental (already authorized) |
| Embed bulk new files | Larger | `/index update` — confirms before proceeding |
| Full reindex | Largest | `/index reindex` only — always confirms |
| Schema/scope change | — | Prompts to reindex; never automatic |

The watcher auto-embeds individual file changes as you edit. When a debounce window accumulates
more than `watcherBulkThreshold` (default 50) file changes — e.g. after a branch switch, an
`npm install`, or unpacking a dataset — auto-embed is **suspended** and the footer shows a yellow
warning: `idx: ⚠ N changed · /index update`. Run `/index update` to review and apply the changes
with cost confirmation.

## Configuration

Run `/index config` to open the interactive settings wizard. Key options:

| Setting | Default | Description |
|---|---|---|
| `provider` | `voyage` | Embedding provider (`voyage`, `openrouter`, `local`, `custom`) |
| `watcherBulkThreshold` | `50` | File-change count above which auto-embed is suspended |
| `watcherDebounceMs` | `1000` | Debounce window for batching watcher events (ms) |
| `largeRepoConfirmChunks` | `5000` | Chunk count above which reindex always confirms |
| `chunkLines` | `80` | Lines per chunk window |
| `chunkOverlap` | `20` | Overlap between consecutive chunk windows (lines) |
| `maxFileBytes` | `786432` | Files larger than this are skipped |
| `maxChunkChars` | `12000` | Max characters per chunk |
| `excludeDirs` | (many) | Directory names always excluded |

API keys are read from environment variables only (e.g. `VOYAGE_API_KEY`). Literal key values are
never stored.
