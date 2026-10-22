# Migrate Chalice to Pi 1.0

## Context
Chalice is a heavily modified Pi 0.85.1-era source tree. Core packages and extensions are deeply coupled, while package metadata is already mixed across 0.85.x and 1.0.x. The existing `Chalice/pi-mcp-adapter` remains authoritative and must be preserved.

## Approach
1. Create and verify a dedicated `migration/pi-1.0` branch without changing `main`.
2. Record the current baseline and identify the exact upstream Pi ancestry and release boundaries.
3. Integrate upstream Pi changes incrementally from 0.85.1 through 0.86, 0.87, 0.99, and 1.0, resolving one subsystem at a time.
4. Reconcile package manifests, lockfiles, build configuration, exports, and stale 0.84/0.85 references.
5. Preserve and adapt Chalice core changes, including TUI, permissions, sessions, SubAgents, model behavior, and built-in extension loading.
6. Keep the existing MCP adapter; explicitly prevent conflicts with Pi’s built-in MCP, Codemode, and tool-search extensions. Defer optional Codemode/tool-search adoption unless required.
7. Add or update regression coverage for session/context behavior, extension loading, tool permissions/exposure, SubAgents, TUI behavior, model/runtime APIs, and MCP integration.
8. Run the repository check command after each migration boundary, then perform targeted tests and a final full validation pass.

## Primary areas
- `packages/agent`, `packages/ai`, `packages/coding-agent`, `packages/tui`, `packages/chord`, and `packages/telemetry`
- `Chalice/pi-mcp-adapter`
- `Chalice/SubAgents`
- Other `Chalice/*` built-in extensions
- Workspace manifests, lockfiles, shrinkwraps, build scripts, and tests

## Verification
- Clean branch/baseline before migration.
- Successful type checking and `npm run check` at each boundary.
- Targeted tests for changed subsystems and modified test files.
- Manual smoke tests for startup, onboarding, interactive TUI, permissions, sessions/resume, SubAgents, MCP, and package builds.
- Confirm `main` remains unchanged and the migration branch has no unrelated feature edits.
