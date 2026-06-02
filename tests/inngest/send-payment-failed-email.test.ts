import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { functions, sendPaymentFailedEmailFn } from '@/inngest/functions';

describe('sendPaymentFailedEmailFn', () => {
  it('is registered with the expected id', () => {
    const id = sendPaymentFailedEmailFn.id();
    expect(id).toContain('send-payment-failed-email');
  });

  it('appears in the exported functions registry', () => {
    const ids = (functions as ReadonlyArray<{ id: () => string }>).map((fn) => fn.id());
    expect(ids.some((id) => id.includes('send-payment-failed-email'))).toBe(true);
  });

  it('has a human-friendly name', () => {
    const name = sendPaymentFailedEmailFn.name;
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });
});

// --- C2: PII discipline source-level checks ---------------------------------
//
// The `billing.payment_failed` event payload must NOT carry the recipient
// email — the Inngest function looks it up by userId from the profiles table.
// These source-level guards make the contract explicit and catch any future
// regression that re-introduces customerEmail to the payload.
describe('sendPaymentFailedEmailFn — C2 PII discipline', () => {
  const consumerSrc = readFileSync(
    resolve(__dirname, '..', '..', 'src', 'inngest', 'functions', 'send-payment-failed-email.ts'),
    'utf8',
  );

  it('does NOT read `customerEmail` from event.data (re-fetches via supabase)', () => {
    expect(consumerSrc).not.toMatch(/event\.data\.customerEmail/);
    expect(consumerSrc).not.toMatch(/customerEmail\s*=\s*event\.data/);
  });

  it('reads the email from the profiles row (the source of truth)', () => {
    // The load-context step must SELECT id+email+subscription_status from
    // profiles keyed by userId.
    expect(consumerSrc).toMatch(/from\(['"]profiles['"]\)/);
    expect(consumerSrc).toMatch(/select\(['"]id, email, subscription_status['"]\)/);
    expect(consumerSrc).toMatch(/eq\(['"]id['"],\s*userId\)/);
    // And the row's `email` is what's handed to Resend (not anything from the
    // event payload).
    expect(consumerSrc).toMatch(/row\.email/);
  });

  it('event payload destructure does NOT include customerEmail', () => {
    // M11: the destructure target is now `parseEventData(...)` (Zod boundary
    // parse), so match either the legacy `event.data` shape or the
    // parseEventData shape — both must NOT mention customerEmail.
    const destructure =
      consumerSrc.match(/const\s*\{([^}]+)\}\s*=\s*event\.data;/) ??
      consumerSrc.match(/const\s*\{([^}]+)\}\s*=\s*parseEventData\(/);
    expect(destructure).not.toBeNull();
    expect(destructure?.[1]).not.toMatch(/customerEmail/);
  });
});
