import { describe, it, expect } from 'vitest';

import { normalizeSubscriptionStatus } from '@/lib/stripe/status';

describe('normalizeSubscriptionStatus', () => {
  it('maps active to active', () => {
    expect(normalizeSubscriptionStatus('active')).toBe('active');
  });

  it('maps trialing to trialing (gate treats as access-granting)', () => {
    expect(normalizeSubscriptionStatus('trialing')).toBe('trialing');
  });

  it('maps canceled to canceled', () => {
    expect(normalizeSubscriptionStatus('canceled')).toBe('canceled');
  });

  it('maps past_due to past_due', () => {
    expect(normalizeSubscriptionStatus('past_due')).toBe('past_due');
  });

  it.each([
    ['incomplete'],
    ['incomplete_expired'],
    ['unpaid'],
    ['paused'],
  ])(
    'maps ambiguous Stripe status %s to past_due (fail-closed)',
    (status) => {
      expect(normalizeSubscriptionStatus(status)).toBe('past_due');
    },
  );

  it('maps unknown future Stripe statuses to past_due (fail-closed)', () => {
    expect(normalizeSubscriptionStatus('something_new_stripe_added')).toBe(
      'past_due',
    );
    expect(normalizeSubscriptionStatus('')).toBe('past_due');
  });
});
