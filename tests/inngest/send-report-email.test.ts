import { describe, expect, it } from 'vitest';

import { functions, sendReportEmailFn } from '@/inngest/functions';

describe('sendReportEmailFn', () => {
  it('is registered with the expected id', () => {
    const id = sendReportEmailFn.id();
    expect(id).toContain('send-report-email');
  });

  it('appears in the exported functions registry', () => {
    const ids = (functions as ReadonlyArray<{ id: () => string }>).map((fn) => fn.id());
    expect(ids.some((id) => id.includes('send-report-email'))).toBe(true);
  });

  it('has a human-friendly name', () => {
    const name = sendReportEmailFn.name;
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });
});
