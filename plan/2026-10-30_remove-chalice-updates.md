# Remove Chalice self-updates and update notifications

## Scope
Remove Chalice application self-update functionality and release notifications. Preserve unrelated package/extension updates, model catalog updates, indexing, and normal version reporting.

## Approach
1. Trace the self-update command paths in `packages/coding-agent/src/package-manager-cli.ts`, `cli/args.ts`, and `config.ts`. Remove application self-update execution, install detection and instructions used only by it, while retaining explicit package and model update commands. Adjust CLI help and error handling to match.
2. Remove automatic release checks and notification rendering from `modes/interactive/interactive-mode.ts` and any startup wiring in `main.ts`. Remove release-check utilities and Windows self-update quarantine code only where no other features depend on them. Inspect update-related telemetry and remove it if it exists solely for the removed update flow; preserve independent changelog behavior.
3. Remove the update-notification setting and selector wiring in `core/settings-manager.ts` and `modes/interactive/components/settings-selector.ts`, plus the obsolete tip in `Chalice/HeaderFull/src/index.ts`. Update relevant documentation other than README files and add an Unreleased changelog entry on main.
4. Update targeted tests in `test/config.test.ts`, `test/package-command-paths.test.ts`, `test/settings-selector.test.ts`, and `test/version-check.test.ts` as applicable. Add regression coverage proving startup does not check or notify about application updates, self-update is unavailable, and package/model updates still work. Preserve historical session fixtures and released changelog entries.

## Verification
- Run each modified test file using the repository's specified package-level test command.
- Run `npm run check` with full output, fixing errors, warnings, and infos.
- Run `./chalice-test.sh` for the preferred UI testing round; verify startup and settings show no update notification or toggle and unrelated update commands remain available.
- Search remaining source and help text for obsolete application-update references; do not edit README files without explicit confirmation.
