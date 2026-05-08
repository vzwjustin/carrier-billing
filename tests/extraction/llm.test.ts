import { describe, it, expect } from 'vitest';

// Gated by RUN_LLM_TESTS=1 (see `pnpm test:llm`). When unset we skip the
// describe block entirely so CI doesn't burn API credit or require an
// ANTHROPIC_API_KEY. Fixtures are not yet committed — the real cases will
// land alongside the bill PDFs from the anonymization script.
const SHOULD_RUN = process.env.RUN_LLM_TESTS === '1';
const d = SHOULD_RUN ? describe : describe.skip;

d('llm extraction', () => {
  it.todo('runs against fixture bills');
  it.todo('totals match the fixture within 1¢');
  it.todo('line counts match the fixture');
  it.todo('schema-validation retry recovers from a malformed first response');

  // Sanity reference so the import isn't stripped if a real test is added.
  it('module loads', () => {
    expect(true).toBe(true);
  });
});
