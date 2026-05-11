import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks --------------------------------------------------------------
// These must be declared before importing the route under test.

const constructEventMock = vi.fn();

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: (...args: unknown[]) => constructEventMock(...args),
    },
  }),
}));

// Chainable supabase admin mock that models the surface the hardened webhook
// route uses:
//   - .from('billing_events').select('id, processed_status').eq(...).maybeSingle()
//   - .from('billing_events').insert(row).select('id, processed_status').maybeSingle()
//   - .from('billing_events').update(patch).eq('id', billingEventId)  → { error }
//
// Per-test knobs let each case set the existence-check + insert outcomes.

type MaybeSingleResult = {
  data: { id: string; processed_status: 'success' | 'failed' | null } | null;
  error: null | { code?: string; message: string };
};
type InsertResult = {
  data: { id: string; processed_status: 'success' | 'failed' | null } | null;
  error: null | { code?: string; message: string };
};

const maybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();
const insertMock = vi.fn<(row: unknown) => Promise<InsertResult>>();
const updateMock = vi.fn<(patch: unknown) => Promise<{ error: null }>>(
  async () => ({ error: null }),
);

const fromMock = vi.fn((_table: string) => ({
  select: () => ({
    eq: () => ({
      maybeSingle: () => maybeSingleMock(),
    }),
  }),
  insert: (row: unknown) => ({
    select: () => ({
      maybeSingle: async () => insertMock(row),
    }),
  }),
  // R1-F1: markInFlight now uses a CAS chain `.update().eq().or().select()`.
  // The builder below is thenable so legacy `await .update().eq(...)` (used by
  // markSuccess / markFailure) still resolves to `{ error }`; chaining
  // `.or()` / `.is()` and terminating with `.select()` exercises the CAS path
  // and resolves to `{ data: [{id}], error: null }` (or the error from
  // updateMock). updateMock's return value flows through both paths.
  update: (patch: unknown) => {
    const chainable: {
      eq: () => typeof chainable;
      is: () => typeof chainable;
      or: () => typeof chainable;
      select: () => Promise<{
        data: Array<{ id: string }> | null;
        error: unknown;
      }>;
      then: (
        onFulfilled: (v: { error: null }) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise<unknown>;
    } = {
      eq: () => chainable,
      is: () => chainable,
      or: () => chainable,
      select: async () => {
        const r = await updateMock(patch);
        return r.error
          ? { data: null, error: r.error }
          : { data: [{ id: 'be_mock' }], error: null };
      },
      then: (onFulfilled, onRejected) =>
        updateMock(patch).then(onFulfilled, onRejected),
    };
    return chainable;
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: fromMock }),
}));

// Stub the handler so we don't need a full Supabase mock for downstream logic.
vi.mock('@/lib/stripe/handlers', () => ({
  handleStripeEvent: vi.fn(async () => undefined),
}));

// Env shim — the route imports `env.STRIPE_WEBHOOK_SECRET`.
vi.mock('@/env', () => ({
  env: {
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
  },
}));

// Import after mocks are registered.
import { POST } from '@/app/api/stripe/webhook/route';

function makeRequest(body: string, signature: string | null): Request {
  const headers = new Headers();
  if (signature !== null) headers.set('stripe-signature', signature);
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

beforeEach(() => {
  constructEventMock.mockReset();
  maybeSingleMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  updateMock.mockImplementation(async () => ({ error: null }));
  fromMock.mockClear();
});

describe('POST /api/stripe/webhook', () => {
  it('returns 400 on invalid signature', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('bad sig');
    });

    const res = await POST(makeRequest('{}', 'sig_bad'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    const res = await POST(makeRequest('{}', null));
    expect(res.status).toBe(400);
    expect(constructEventMock).not.toHaveBeenCalled();
  });

  it('returns 200 with { received: true } on a valid checkout.session.completed event', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'user_123',
          customer: 'cus_abc',
        },
      },
    });

    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    insertMock.mockResolvedValue({
      data: { id: 'be_1', processed_status: null },
      error: null,
    });

    const res = await POST(makeRequest('{}', 'sig_ok'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { received: boolean; deduped?: boolean };
    expect(json).toEqual({ received: true });

    // Confirm we actually wrote a billing_events row with the right shape.
    expect(insertMock).toHaveBeenCalledTimes(1);
    const inserted = insertMock.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(inserted['stripe_event_id']).toBe('evt_test_1');
    expect(inserted['type']).toBe('checkout.session.completed');
    expect(inserted['user_id']).toBe('user_123');
  });

  it('returns 200 with { deduped: true } when the event already exists with processed_status=success', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_test_dup',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'user_123' } },
    });

    maybeSingleMock.mockResolvedValue({
      data: { id: 'row_existing', processed_status: 'success' },
      error: null,
    });

    const res = await POST(makeRequest('{}', 'sig_ok'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { received: boolean; deduped?: boolean };
    expect(json).toEqual({ received: true, deduped: true });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('treats a unique-violation race on insert as deduped (when winning row is success)', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_race',
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_x' } },
    });

    // First existence check: nothing.
    // Second (race fetch) check: a successfully-processed row.
    maybeSingleMock
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: { id: 'row_raced', processed_status: 'success' },
        error: null,
      });
    insertMock.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate' },
    });

    const res = await POST(makeRequest('{}', 'sig_ok'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { received: boolean; deduped?: boolean };
    expect(json).toEqual({ received: true, deduped: true });
  });
});
