# Remove permission-mode footer status UI

## Context

The footer indicator is implemented in `Chalice/PermissionModes/src/status.ts` (`updateStatus`). It renders the active mode, the sandboxed/not-sandboxed label and `alt+m`, plus network state (`filtered`, `open`, or `unrestricted`) and `alt+n`. Calls that refresh it are in `Chalice/PermissionModes/src/index.ts` and `Chalice/PermissionModes/src/acceptance.ts`.

## Approach

- Stop publishing the `perm` footer status and remove its update calls/imports from the permission-mode extension and acceptance coordinator. If a status may already have been published, clear it once with `ctx.ui.setStatus("perm", undefined)` during initialization or the first mode setup; the UI API supports clearing a status this way.
- Remove `Chalice/PermissionModes/src/status.ts` once it has no callers.
- Preserve the permission modes, sandbox enforcement, network filtering and toggle behavior, `alt+m` / `alt+n` shortcuts, commands, and notifications. This change is limited to the persistent footer display.

## Files

- `Chalice/PermissionModes/src/status.ts`
- `Chalice/PermissionModes/src/index.ts`
- `Chalice/PermissionModes/src/acceptance.ts`
- `packages/coding-agent/test/suite/permission-modes.test.ts` (add coverage that the permission extension does not publish a footer status during mode changes/network changes, if the harness exposes status calls)

## Verification

- Run the focused permission-mode test using the repository's faux-provider harness; verify modes, sandbox/network controls, and shortcuts remain functional and the footer status is absent.
- Run `npm run check` as required after code changes.
