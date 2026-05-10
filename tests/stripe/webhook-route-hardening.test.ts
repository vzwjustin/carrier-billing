import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

/**
 * H8 — webhook route hardening.
 *
 * The pre-hardening behavior swallowed handler errors and ack'd 200, so
 * Stripe never retried. After the fix:
 *
 *   - Successful handler invocation ⇒ 200 + processed_status='success'.
 *   - Handler failure ⇒ 5xx + processed_status='failed' + last_error
 *     populated. Stripe retries automatically.
 *   - Already-processed (processed_status='success') events ⇒ 200 deduped
 *     immediately, handler not re-invoked.
 *   - Failed-then-replayed events ⇒ handler is re-invoked with
 *     previousStatus='failed' so non-idempotent ops (credit grant) skip.
 */

const constructEventMock = vi.fn();

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: (...args: unknown[]) => constructEventMock(...args),
    },
  }),
}));

// In-memory billing_events table that mirrors the production surface for the
// hardened route (select existence, insert with select-back, update bookkeeping).
type BillingEventRow = {
  id: string;
  stripe_event_id: string;
  processed_status: 'success' | 'failed' | null;
  last_attempted_at: string | null;
  processed_at: string | null;
  last_error: string | null;
};
const billingEvents: BillingEventRow[] = [];

// M-S1: a per-test toggle so we can simulate the markSuccess UPDATE failing
// after the handler succeeded. When set, the next UPDATE that writes
// `processed_status='success'` returns an error and leaves the row's
// processed_status untouched.
let nextMarkSuccessError: { message: string } | null = null;

const fromMock = vi.fn(() => ({
  select: () => ({
    eq: (_col: string, val: string) => ({
      maybeSingle: async () => {
        const row = billingEvents.find((r) => r.stripe_event_id === val);
        return row
          ? {
              data: { id: row.id, processed_status: row.processed_status },
              error: null,
            }
          : { data: null, error: null };
      },
    }),
  }),
  insert: (row: unknown) => ({
    select: () => ({
      maybeSingle: async () => {
        const r = row as { stripe_event_id: string };
        if (billingEvents.some((b) => b.stripe_event_id === r.stripe_event_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate' } };
        }
        const newRow: BillingEventRow = {
          id: `be_${billingEvents.length + 1}`,
          stripe_event_id: r.stripe_event_id,
          processed_status: null,
          last_attempted_at: null,
          processed_at: null,
          last_error: null,
        };
        billingEvents.push(newRow);
        return {
          data: { id: newRow.id, processed_status: newRow.processed_status },
          error: null,
        };
      },
    }),
  }),
  update: (patch: Record<string, unknown>) => ({
    eq: async (_col: string, val: string) => {
      // M-S1 simulation: fail the markSuccess UPDATE only.
      if (
        nextMarkSuccessError &&
        patch['processed_status'] === 'success'
      ) {
        const err = nextMarkSuccessError;
        nextMarkSuccessError = null;
        return { error: err };
      }
      const row = billingEvents.find((r) => r.id === val);
      if (row) {
        if ('processed_status' in patch) {
          row.processed_status = patch['processed_status'] as
            | 'success'
            | 'failed'
            | null;
        }
        if ('processed_at' in patch) {
          row.processed_at = patch['processed_at'] as string | null;
        }
        if ('last_error' in patch) {
          row.last_error = patch['last_error'] as string | null;
        }
        if ('last_attempted_at' in patch) {
          row.last_attempted_at = patch['last_attempted_at'] as string | null;
        }
      }
      return { error: null };
    },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: fromMock }),
}));

const handleStripeEventMock = vi.fn<
  (
    event: Stripe.Event,
    supabase: unknown,
    ctx?: { previousStatus: 'success' | 'failed' | null },
  ) => Promise<void>
>();

vi.mock('@/lib/stripe/handlers', () => ({
  handleStripeEvent: (
    event: Stripe.Event,
    supabase: unknown,
    ctx?: { previousStatus: 'success' | 'failed' | null },
  ) => handleStripeEventMock(event, supabase, ctx),
}));

vi.mock('@/env', () => ({
  env: { STRIPE_WEBHOOK_SECRET: 'whsec_test' },
}));

import { POST } from '@/app/api/stripe/webhook/route';

function makeRequest(body: string): Request {
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_ok' },
    body,
  });
}

function makeCheckoutEvent(id: string): Stripe.Event {
  return {
    id,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        client_reference_id: 'user_1',
        customer: 'cus_x',
        mode: 'payment',
      },
    },
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  constructEventMock.mockReset();
  fromMock.mockClear();
  handleStripeEventMock.mockReset();
  handleStripeEventMock.mockResolvedValue(undefined);
  billingEvents.length = 0;
  nextMarkSuccessError = null;
});

describe('POST /api/stripe/webhook — H8 processed_status bookkeeping', () => {
  it('handler success ⇒ 200, processed_status=success, processed_at set, last_error null', async () => {
    const event = makeCheckoutEvent('evt_h8_ok');
    constructEventMock.mockReturnValue(event);

    const res = await POST(makeRequest('{}'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; deduped?: boolean };
    expect(body).toEqual({ received: true });

    expect(handleStripeEventMock).toHaveBeenCalledTimes(1);
    expect(handleStripeEventMock.mock.calls[0]?.[2]).toEqual({
      previousStatus: null,
    });

    const row = billingEvents.find((r) => r.stripe_event_id === 'evt_h8_ok');
    expect(row?.processed_status).toBe('success');
    expect(row?.processed_at).toEqual(expect.any(String));
    expect(row?.last_error).toBeNull();
  });

  it('handler failure ⇒ 5xx, processed_status=failed, last_error populated (Stripe will retry)', async () => {
    const event = makeCheckoutEvent('evt_h8_fail');
    constructEventMock.mockReturnValue(event);
    handleStripeEventMock.mockRejectedValueOnce(
      new Error('downstream RPC blew up'),
    );

    const res = await POST(makeRequest('{}'));
    expect(res.status).toBe(500);

    const row = billingEvents.find((r) => r.stripe_event_id === 'evt_h8_fail');
    expect(row?.processed_status).toBe('failed');
    expect(row?.last_error).toContain('downstream RPC blew up');
    expect(row?.processed_at).toBeNull();
  });

  it('handler failure: last_error is truncated and PII-scrubbed', async () => {
    const event = makeCheckoutEvent('evt_h8_pii');
    constructEventMock.mockReturnValue(event);
    handleStripeEventMock.mockRejectedValueOnce(
      new Error(
        'lookup failed for user@example.com (acct 1234567890123): ' + 'x'.repeat(800),
      ),
    );

    const res = await POST(makeRequest('{}'));
    expect(res.status).toBe(500);
    const row = billingEvents.find((r) => r.stripe_event_id === 'evt_h8_pii');
    expect(row?.last_error?.length ?? 0).toBeLessThanOrEqual(500);
    // Email + long digit run should be scrubbed.
    expect(row?.last_error).not.toContain('user@example.com');
    expect(row?.last_error).not.toContain('1234567890123');
    expect(row?.last_error).toContain('[email]');
  });

  it('event already processed=success ⇒ 200 deduped, handler not invoked', async () => {
    // Pre-seed the row as already processed.
    billingEvents.push({
      id: 'be_seeded',
      stripe_event_id: 'evt_dup_success',
      processed_status: 'success',
      processed_at: new Date().toISOString(),
      last_attempted_at: null,
      last_error: null,
    });

    const event = makeCheckoutEvent('evt_dup_success');
    constructEventMock.mockReturnValue(event);

    const res = await POST(makeRequest('{}'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; deduped?: boolean };
    expect(body).toEqual({ received: true, deduped: true });
    expect(handleStripeEventMock).not.toHaveBeenCalled();
  });

  it('event with processed_status=failed ⇒ handler re-invoked with previousStatus=failed', async () => {
    billingEvents.push({
      id: 'be_failed_seed',
      stripe_event_id: 'evt_replay',
      processed_status: 'failed',
      processed_at: null,
      last_attempted_at: new Date(Date.now() - 5_000).toISOString(),
      last_error: 'previous failure',
    });

    const event = makeCheckoutEvent('evt_replay');
    constructEventMock.mockReturnValue(event);

    const res = await POST(makeRequest('{}'));
    expect(res.status).toBe(200);
    expect(handleStripeEventMock).toHaveBeenCalledTimes(1);
    expect(handleStripeEventMock.mock.calls[0]?.[2]).toEqual({
      previousStatus: 'failed',
    });

    const row = billingEvents.find((r) => r.stripe_event_id === 'evt_replay');
    expect(row?.processed_status).toBe('success');
    expect(row?.last_error).toBeNull();
  });

  it('M-S1: markSuccess bookkeeping failure ⇒ 5xx so Stripe retries', async () => {
    // The handler succeeded, but the bookkeeping UPDATE that flips
    // processed_status to success returns an error. The route MUST 5xx
    // (not 200) so Stripe retries the delivery and the next attempt has a
    // chance to mark the row clean. The handler's side effects already
    // landed; the credit grant is gated on previousStatus, so a retry won't
    // double-credit.
    const event = makeCheckoutEvent('evt_marksuccess_fail');
    constructEventMock.mockReturnValue(event);
    nextMarkSuccessError = { message: 'bookkeeping pg blew up' };

    const res = await POST(makeRequest('{}'));
    expect(res.status).toBe(500);

    // Handler still ran exactly once.
    expect(handleStripeEventMock).toHaveBeenCalledTimes(1);
    // Row remains with processed_status=null (the failing UPDATE didn't touch it).
    const row = billingEvents.find(
      (r) => r.stripe_event_id === 'evt_marksuccess_fail',
    );
    expect(row?.processed_status).toBeNull();
  });

  it('Stripe retry of a failed event flips processed_status from failed to success', async () => {
    const event = makeCheckoutEvent('evt_retry_chain');
    constructEventMock.mockReturnValue(event);
    handleStripeEventMock.mockRejectedValueOnce(new Error('first attempt boom'));

    const first = await POST(makeRequest('{}'));
    expect(first.status).toBe(500);
    let row = billingEvents.find((r) => r.stripe_event_id === 'evt_retry_chain');
    expect(row?.processed_status).toBe('failed');

    // Second delivery (Stripe retry) — handler succeeds.
    handleStripeEventMock.mockResolvedValueOnce(undefined);
    const second = await POST(makeRequest('{}'));
    expect(second.status).toBe(200);
    expect(handleStripeEventMock).toHaveBeenCalledTimes(2);
    expect(handleStripeEventMock.mock.calls[1]?.[2]).toEqual({
      previousStatus: 'failed',
    });

    row = billingEvents.find((r) => r.stripe_event_id === 'evt_retry_chain');
    expect(row?.processed_status).toBe('success');
  });
});
