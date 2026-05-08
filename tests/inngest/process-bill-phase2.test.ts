import { describe, expect, it } from 'vitest';

import { processBillFn } from '@/inngest/functions/process-bill';
import { functions } from '@/inngest/functions';

/**
 * Phase 2 structural smoke tests for the process-bill function.
 *
 * We deliberately don't try to invoke the Inngest function or run the rules
 * engine here — that requires a fully-wired Inngest test harness plus mocked
 * Anthropic + Supabase. Those live in the integration suite. These tests just
 * pin the public surface so a refactor doesn't accidentally break wiring.
 */
describe('processBillFn (phase 2)', () => {
  it('still has id "process-bill"', () => {
    const id = processBillFn.id();
    expect(id).toContain('process-bill');
  });

  it('is still exported from the functions registry', () => {
    expect(functions).toContain(processBillFn);
  });

  it('exposes a stable name', () => {
    expect(typeof processBillFn.name).toBe('string');
    expect(processBillFn.name.length).toBeGreaterThan(0);
  });
});
