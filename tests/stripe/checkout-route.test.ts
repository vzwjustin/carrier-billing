import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ----------------------------------------------------------------

const getUserMock = vi.fn<
  () => Promise<{ data: { user: { id: string; email: string | null } | null } }>
>();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
  }),
}));

// Admin supabase: model the chained .from(...).select(...).eq(...).maybeSingle()
// for profile lookup, and .from(...).update(...).eq(...) for the customer id
// persistence.
type ProfileResult = {
  data: { id: string; stripe_customer_id: string | null } | null;
  error: null | { message: string };
};

const maybeSingleMock = vi.fn<() => Promise<ProfileResult>>();
const updateEqMock = vi.fn<() => Promise<{ error: null | { message: string } }>>();
const updateMock = vi.fn((_patch: unknown) => ({ eq: () => updateEqMock() }));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => maybeSingleMock() }),
      }),
      update: (patch: unknown) => updateMock(patch),
    }),
  }),
}));

const customersCreateMock = vi.fn<
  (args: { email?: string; metadata?: Record<string, string> }) => Promise<{ id: string }>
>();
const sessionsCreateMock = vi.fn<
  (args: Record<string, unknown>) => Promise<{ url: string | null }>
>();

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    customers: { create: (args: Parameters<typeof customersCreateMock>[0]) => customersCreateMock(args) },
    checkout: { sessions: { create: (args: Parameters<typeof sessionsCreateMock>[0]) => sessionsCreateMock(args) } },
  }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    STRIPE_PRICE_ID_ONE_TIME: 'price_one_time_test',
    STRIPE_PRICE_ID_SUBSCRIPTION: 'price_sub_test',
  },
}));

import { POST } from '@/app/api/stripe/checkout/route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/stripe/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  maybeSingleMock.mockReset();
  updateMock.mockClear();
  updateEqMock.mockReset();
  customersCreateMock.mockReset();
  sessionsCreateMock.mockReset();
});

describe('POST /api/stripe/checkout', () => {
  it('returns 401 when there is no authenticated user', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await POST(makeRequest({ mode: 'one_time' }));
    expect(res.status).toBe(401);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when mode is invalid', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user_1', email: 'u@example.com' } },
    });

    const res = await POST(makeRequest({ mode: 'lifetime' }));
    expect(res.status).toBe(400);
  });

  it('creates a Stripe customer when the profile has none, then creates a session', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user_1', email: 'u@example.com' } },
    });
    maybeSingleMock.mockResolvedValue({
      data: { id: 'user_1', stripe_customer_id: null },
      error: null,
    });
    customersCreateMock.mockResolvedValue({ id: 'cus_new' });
    updateEqMock.mockResolvedValue({ error: null });
    sessionsCreateMock.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/sess_one',
    });

    const res = await POST(makeRequest({ mode: 'one_time' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toBe('https://checkout.stripe.com/c/sess_one');

    // Customer was created with email + userId metadata.
    expect(customersCreateMock).toHaveBeenCalledWith({
      email: 'u@example.com',
      metadata: { userId: 'user_1' },
    });

    // Profile was updated with the new customer id.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const patch = updateMock.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(patch['stripe_customer_id']).toBe('cus_new');

    // Checkout session was constructed with the right price + mode.
    expect(sessionsCreateMock).toHaveBeenCalledTimes(1);
    const params = sessionsCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['mode']).toBe('payment');
    expect(params['customer']).toBe('cus_new');
    expect(params['client_reference_id']).toBe('user_1');
    expect(params['line_items']).toEqual([
      { price: 'price_one_time_test', quantity: 1 },
    ]);
  });

  it('reuses an existing customer id and creates a subscription session', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user_2', email: 'u2@example.com' } },
    });
    maybeSingleMock.mockResolvedValue({
      data: { id: 'user_2', stripe_customer_id: 'cus_existing' },
      error: null,
    });
    sessionsCreateMock.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/sess_sub',
    });

    const res = await POST(makeRequest({ mode: 'subscription' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toBe('https://checkout.stripe.com/c/sess_sub');

    expect(customersCreateMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();

    const params = sessionsCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['mode']).toBe('subscription');
    expect(params['customer']).toBe('cus_existing');
    expect(params['line_items']).toEqual([
      { price: 'price_sub_test', quantity: 1 },
    ]);
  });

  it('returns { url } in the success body', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user_3', email: 'u3@example.com' } },
    });
    maybeSingleMock.mockResolvedValue({
      data: { id: 'user_3', stripe_customer_id: 'cus_3' },
      error: null,
    });
    sessionsCreateMock.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/sess_x',
    });

    const res = await POST(makeRequest({ mode: 'one_time' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['url']);
  });
});
