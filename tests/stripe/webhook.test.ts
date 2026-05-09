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

// Chainable supabase admin mock. Each test sets the resolved values for
// the existence check (`maybeSingle`) and the insert.
type MaybeSingleResult = {
  data: { id: string; handled_at: string | null } | null;
  error: null | { code?: string; message: string };
};
type InsertResult = { data: unknown; error: null | { code?: string; message: string } };
type UpdateResult = { data: unknown; error: null | { code?: string; message: string } };

const maybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();
const insertMock = vi.fn<(row: unknown) => Promise<InsertResult>>();
const updateEqMock = vi.fn<() => Promise<UpdateResult>>();
const updateMock = vi.fn((_row: unknown) => ({
  eq: () => updateEqMock(),
}));

const fromMock = vi.fn((_table: string) => ({
  select: () => ({
    eq: () => ({
      maybeSingle: () => maybeSingleMock(),
    }),
  }),
  insert: (row: unknown) => insertMock(row),
  update: (row: unknown) => updateMock(row),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: fromMock }),
}));

// Env shim — the route imports `env.STRIPE_WEBHOOK_SECRET`.
vi.mock('@/env', () => ({
  env: {
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
  },
}));

const handleStripeEventMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);

vi.mock('@/lib/stripe/handlers', () => ({
  handleStripeEvent: (...args: unknown[]) => handleStripeEventMock(...args),
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
  updateEqMock.mockReset();
  updateMock.mockClear();
  handleStripeEventMock.mockClear();
  fromMock.mockClear();
  updateEqMock.mockResolvedValue({ data: null, error: null });
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
    insertMock.mockResolvedValue({ data: null, error: null });

    const res = await POST(makeRequest('{}', 'sig_ok'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { received: boolean; deduped?: boolean };
    expect(json).toEqual({ received: true });

    // Confirm we actually wrote a billing_events row with the right shape.
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(updateEqMock).toHaveBeenCalledTimes(1);
    const inserted = insertMock.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(inserted['stripe_event_id']).toBe('evt_test_1');
    expect(inserted['type']).toBe('checkout.session.completed');
    expect(inserted['user_id']).toBe('user_123');
  });

  it('returns 200 with { deduped: true } when the event already exists', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_test_dup',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'user_123' } },
    });

    maybeSingleMock.mockResolvedValue({
      data: { id: 'row_existing', handled_at: '2026-05-01T00:00:00Z' },
      error: null,
    });

    const res = await POST(makeRequest('{}', 'sig_ok'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { received: boolean; deduped?: boolean };
    expect(json).toEqual({ received: true, deduped: true });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('treats a unique-violation race on insert as deduped', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_race',
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_x' } },
    });

    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({
      data: { id: 'row_existing', handled_at: '2026-05-01T00:00:00Z' },
      error: null,
    });
    insertMock.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate' } });

    const res = await POST(makeRequest('{}', 'sig_ok'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { received: boolean; deduped?: boolean };
    expect(json).toEqual({ received: true, deduped: true });
  });

  it('returns 500 and leaves event retryable when the handler fails', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_handler_fail',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'user_123' } },
    });

    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    insertMock.mockResolvedValue({ data: null, error: null });
    handleStripeEventMock.mockRejectedValueOnce(new Error('handler boom'));

    const res = await POST(makeRequest('{}', 'sig_ok'));
    expect(res.status).toBe(500);
    expect(updateEqMock).toHaveBeenCalledTimes(1);
    const updateArg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg['handled_at']).toBeNull();
    expect(updateArg['handler_error']).toBe('handler boom');
  });
});
