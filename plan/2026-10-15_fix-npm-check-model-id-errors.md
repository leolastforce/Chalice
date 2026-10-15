# Fix npm check model ID errors

## Context
`getModel` uses generated provider catalogs with exact model-ID types. Three tests reference IDs that are no longer present for their provider: OpenRouter uses `anthropic/claude-sonnet-4` while the catalog has current Sonnet 4.x IDs, and NVIDIA uses the removed `nvidia/nemotron-3-super-120b-a12b`.

## Approach
1. Inspect the current model metadata in `packages/ai/src/providers/data/openrouter.json` and `nvidia.json`, selecting replacements that support each test’s API/reasoning/tool expectations.
2. Update the affected test references and descriptions in:
   - `packages/ai/test/context-overflow.test.ts`
   - `packages/ai/test/total-tokens.test.ts`
   - `packages/ai/test/stream.test.ts`
3. Do not edit generated model files or `README.md`; regenerate only if catalog generation reveals stale generated output.
4. Run the relevant AI tests, then run `npm run check` and resolve any resulting type or expectation errors.

## Verification
- `getModel` accepts all updated IDs with no TS2345 errors.
- The affected tests pass when their provider credentials are configured; credential-gated tests remain skipped otherwise.
- Full `npm run check` completes without errors, warnings, or infos.