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

// In-memory billing_events table that models the unique-constraint dedup +
// per-event processing state introduced in 0008. It is intentionally minimal
// — only the row-shape the route actually reads/writes is supported.
type BillingEventRow = {
  id: string;
  stripe_event_id: string;
  processed_status: 'success' | 'failed' | null;
  last_attempted_at: string | null;
  processed_at: string | null;
  last_error: string | null;
};
const billingEvents: BillingEventRow[] = [];

const fromMock = vi.fn((_table: string) => ({
  select: (_cols: string) => ({
    eq: (_col: string, val: string) => ({
      maybeSingle: async () => {
        const row = billingEvents.find((r) => r.stripe_event_id === val);
        return row
          ? { data: { id: row.id, processed_status: row.processed_status }, error: null }
          : { data: null, error: null };
      },
    }),
  }),
  insert: (row: unknown) => ({
    select: (_cols: string) => ({
      maybeSingle: async () => {
        const r = row as { stripe_event_id: string };
        if (billingEvents.some((b) => b.stripe_event_id === r.stripe_event_id)) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate' },
          };
        }
        const newRow: BillingEventRow = {
          id: `row_${billingEvents.length + 1}`,
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

    // Replay — same event id. The first attempt marked the row processed=success,
    // so the second should short-circuit before reaching the handler.
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
