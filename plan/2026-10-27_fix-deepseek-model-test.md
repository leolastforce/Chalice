# Fix stale DeepSeek model ID in cache-retention test

## Context
`packages/ai/test/cache-retention.test.ts` references `MODELS.opencode["deepseek-v4-flash"]`, but the generated model catalog exposes `deepseek-v4.1-flash`.

## Approach
- Inspect the failing test and model catalog generation/source to confirm the canonical OpenCode model ID.
- Update the test reference to the current model ID without changing production model metadata.
- Run the focused AI test and `npm run check` to verify type checking and behavior.

## Files
- `packages/ai/test/cache-retention.test.ts`
- Relevant model catalog source/generated files only if inspection shows the catalog itself is stale.

## Verification
- Run the specific cache-retention test.
- Run `npm run check` and review the diff.