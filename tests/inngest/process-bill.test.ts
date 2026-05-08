import { describe, expect, it } from 'vitest';

import { processBillFn } from '@/inngest/functions/process-bill';
import { functions } from '@/inngest/functions';

describe('processBillFn', () => {
  it('is registered with the expected id', () => {
    const id = processBillFn.id();
    expect(id).toContain('process-bill');
  });

  it('exposes a stable name', () => {
    // The Inngest SDK exposes a `.name` getter on the function instance.
    // We don't pin the exact string, just that it's a non-empty string.
    expect(typeof processBillFn.name).toBe('string');
    expect(processBillFn.name.length).toBeGreaterThan(0);
  });

  it('is exported from the functions registry', () => {
    expect(functions).toContain(processBillFn);
  });
});
