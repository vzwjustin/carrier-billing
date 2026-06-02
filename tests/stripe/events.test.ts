import { describe, expect, it } from 'vitest';

import {
  HANDLED_STRIPE_EVENT_TYPES,
  isHandledStripeEventType,
} from '@/lib/stripe/events';

describe('stripe event registration', () => {
  it('includes delayed Checkout async payment outcome events', () => {
    expect(HANDLED_STRIPE_EVENT_TYPES).toMatchObject({
      CheckoutSessionAsyncPaymentSucceeded:
        'checkout.session.async_payment_succeeded',
      CheckoutSessionAsyncPaymentFailed: 'checkout.session.async_payment_failed',
    });
    expect(
      isHandledStripeEventType('checkout.session.async_payment_succeeded'),
    ).toBe(true);
    expect(
      isHandledStripeEventType('checkout.session.async_payment_failed'),
    ).toBe(true);
  });
});
