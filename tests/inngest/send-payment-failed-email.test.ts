import { describe, expect, it } from 'vitest';

import {
  functions,
  sendPaymentFailedEmailFn,
} from '@/inngest/functions';

describe('sendPaymentFailedEmailFn', () => {
  it('is registered with the expected id', () => {
    const id = sendPaymentFailedEmailFn.id();
    expect(id).toContain('send-payment-failed-email');
  });

  it('appears in the exported functions registry', () => {
    const ids = (functions as ReadonlyArray<{ id: () => string }>).map((fn) =>
      fn.id(),
    );
    expect(ids.some((id) => id.includes('send-payment-failed-email'))).toBe(
      true,
    );
  });

  it('has a human-friendly name', () => {
    const name = sendPaymentFailedEmailFn.name;
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });
});
