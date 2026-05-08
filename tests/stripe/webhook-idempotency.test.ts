import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

// --- Mocks --------------------------------------------------------------

const constructEventMock = vi.fn();

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: (...args: unknown[]) => constructEventMock(...args),
    },
  }),
}));

// In-memory billing_events table to simulate the unique-constraint based
// idempotency check. Pre-existence check returns the row if seen before;
// insert appends to the in-memory store and returns a 23505 if a duplicate
// id slips through (the race path).
type BillingEventRow = { id: string; stripe_event_id: string };
const billingEvents: BillingEventRow[] = [];

const fromMock = vi.fn((_table: string) => ({
  select: (_cols: string) => ({
    eq: (_col: string, val: string) => ({
      maybeSingle: async () => {
        const row = billingEvents.find((r) => r.stripe_event_id === val);
        return { data: row ? { id: row.id } : null, error: null };
      },
    }),
  }),
  insert: async (row: unknown) => {
    const r = row as { stripe_event_id: string };
    if (billingEvents.some((b) => b.stripe_event_id === r.stripe_event_id)) {
      return {
        data: null,
        error: { code: '23505', message: 'duplicate' },
      };
    }
    billingEvents.push({
      id: `row_${billingEvents.length + 1}`,
      stripe_event_id: r.stripe_event_id,
    });
    return { data: null, error: null };
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: fromMock }),
}));

// The handler chain we want to assert is gated by idempotency.
const handleStripeEventMock =
  vi.fn<(event: Stripe.Event) => Promise<void>>();

vi.mock('@/lib/stripe/handlers', () => ({
  handleStripeEvent: (event: Stripe.Event) => handleStripeEventMock(event),
}));

vi.mock('@/env', () => ({
  env: { STRIPE_WEBHOOK_SECRET: 'whsec_test' },
}));

// Import after mocks are registered.
import { POST } from '@/app/api/stripe/webhook/route';

function makeRequest(body: string, signature: string): Request {
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body,
  });
}

function makeCheckoutEvent(id: string): Stripe.Event {
  return {
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        client_reference_id: 'user_1',
        customer: 'cus_x',
        mode: 'payment',
      },
    },
    // Cast to satisfy the type — we only touch the fields the route reads.
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  constructEventMock.mockReset();
  fromMock.mockClear();
  handleStripeEventMock.mockReset();
  handleStripeEventMock.mockResolvedValue(undefined);
  billingEvents.length = 0;
});

describe('POST /api/stripe/webhook — idempotency', () => {
  it('replaying the same checkout.session.completed event twice calls the handler once', async () => {
    const event = makeCheckoutEvent('evt_same_1');
    constructEventMock.mockReturnValue(event);

    const first = await POST(makeRequest('{}', 'sig_ok'));
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      received: boolean;
      deduped?: boolean;
    };
    expect(firstJson).toEqual({ received: true });
    expect(handleStripeEventMock).toHaveBeenCalledTimes(1);

    // Replay — same event id. Pre-check should short-circuit, no handler.
    constructEventMock.mockReturnValue(event);
    const second = await POST(makeRequest('{}', 'sig_ok'));
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      received: boolean;
      deduped?: boolean;
    };
    expect(secondJson).toEqual({ received: true, deduped: true });
    expect(handleStripeEventMock).toHaveBeenCalledTimes(1);
  });

  it('two different events of the same type both call the handler', async () => {
    const a = makeCheckoutEvent('evt_a');
    constructEventMock.mockReturnValueOnce(a);
    const resA = await POST(makeRequest('{}', 'sig_ok'));
    expect(resA.status).toBe(200);

    const b = makeCheckoutEvent('evt_b');
    constructEventMock.mockReturnValueOnce(b);
    const resB = await POST(makeRequest('{}', 'sig_ok'));
    expect(resB.status).toBe(200);

    expect(handleStripeEventMock).toHaveBeenCalledTimes(2);
    const callIds = handleStripeEventMock.mock.calls.map(
      (call) => (call[0] as Stripe.Event).id,
    );
    expect(callIds).toEqual(['evt_a', 'evt_b']);
  });
});
