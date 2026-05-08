import { describe, expect, it } from 'vitest';

import { helloFn } from '@/inngest/functions/hello';

describe('helloFn', () => {
  it('is registered with the expected id', () => {
    // The Inngest SDK exposes function metadata via `id()` and `name()`
    // on the InngestFunction instance.
    const id = helloFn.id();
    expect(id).toContain('hello');
  });

  it('has a human-friendly name', () => {
    const name = helloFn.name;
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });
});
