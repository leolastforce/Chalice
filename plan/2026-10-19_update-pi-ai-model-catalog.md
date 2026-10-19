# Update pi-ai model catalog

## Context
`@earendil-works/pi-ai` generates its built-in model list from `models.dev`, OpenRouter, AI Gateway, NVIDIA, and explicit provider corrections. The generated files are committed, so Pi consumes the snapshot rather than inspecting the repository at runtime. `packages/ai/src/models.generated.ts` and provider shards must be regenerated, not edited directly.

## Approach
1. Run the strict model generator from the repository root to fetch current upstream catalogs and regenerate provider JSON data, generated provider shards, `src/models.generated.ts`, and the manifest.
2. Review the generated diff for model additions/removals, capability/pricing changes, and unintended churn. If an upstream mismatch needs a manual correction, update `packages/ai/scripts/generate-models.ts` and regenerate rather than patching generated output.
3. Add a concise `packages/ai/CHANGELOG.md` entry under the existing Unreleased section if the catalog refresh changes user-visible built-in models.
4. Validate generated data with `npm --prefix packages/ai run check:model-data` and run the required repository check (`npm run check`).

## Files likely to change
- `packages/ai/scripts/generate-models.ts` only if catalog-specific corrections are required
- `packages/ai/src/models.generated.ts`
- `packages/ai/src/providers/*.models.ts`
- `packages/ai/src/providers/data/*.json` and `.manifest.json`
- `packages/ai/CHANGELOG.md`

## Verification
- Strict generation completes successfully with network-backed sources.
- Generated model data validation passes.
- `npm run check` completes with no errors, warnings, or infos.
- Review `git diff` to confirm only intended catalog and changelog changes are present.
