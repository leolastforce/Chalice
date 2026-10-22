# Fix welcome banner after Pi 1.0 migration

## Context and likely cause

`Chalice/HeaderFull/src/index.ts` is a custom header extension that replaces Pi's loaded-resource panel after recognizing Pi's mounted TUI layout. Its own code still defines and renders rotating tips, and its section parser explicitly recognizes Context, Skills, Prompts, and Extensions. Therefore, the missing tips and reappearing native Context/Extensions likely indicate that the extension's layout detection/removal bridge no longer matches Pi 1.0's UI tree (or its loaded-resource component's text/API shape), causing the native panel fallback to remain. The extension logs an “unrecognized Chalice layout” notice if panel discovery fails. Confirm this against Pi 1.0 source and migration commits before changing code; this is not proven from the extension file alone.

The repository includes Pi 0.86 migration commit `c58963a70`, but it does not contain this `Chalice/HeaderFull` path, so that historical file comparison is unavailable at that ref. The current extension comments specifically describe assumptions from Pi 0.80–0.84, which are a likely stale integration point.

## Approach

1. Inspect the current extension's remaining render/attach lifecycle and fallback behavior, plus full history/diff of relevant migration commits.
2. Compare Pi 0.99.9/1.0 upstream changes to the interactive TUI layout, startup resource components, and custom-header extension API; determine whether children structure, collapse text, or hook timing changed.
3. Trace the observed symptoms to the exact failure: establish whether the extension is loaded, whether its hook runs, whether the panel is found, and whether tip rendering is reached. Use the existing layout notice/logging and focused tests or a minimal instrumented reproduction.
4. Update the bridge to the supported Pi 1.0 interface/layout, preserving native panel restoration and unknown-layout safety. If the API has no stable structured resource hook, isolate and document a version-specific adapter rather than broadening unsafe tree mutation.
5. Add regression coverage for Pi 1.0's tree/resource shape, asserting native Context/Extensions are suppressed and the Full banner renders a rotating Tip; retain tests for old supported layouts as applicable.
6. Run focused tests for HeaderFull and `npm run check`; do not run build or full test suite unless requested.

## Files to change

- `Chalice/HeaderFull/src/index.ts` — adapt resource panel discovery/replacement and any rendering lifecycle affected by Pi 1.0.
- HeaderFull test files (locate during implementation; add if absent) — cover Pi 1.0 resource layout, tip visibility, and native panel suppression.
- Possibly `packages/coding-agent/src/modes/interactive/...` only if investigation confirms Pi's custom-header/resource API needs a compatible exposed hook; avoid modifying upstream-integrated behavior without evidence.

## Verification

- Reproduce the Full welcome screen with Pi 1.0 and confirm tips appear while default Context/Extensions do not.
- Confirm minimal/none banner modes and unknown-layout fallback remain intact.
- Run relevant HeaderFull tests and `npm run check`.