import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ----------------------------------------------------------------

const getUserMock =
  vi.fn<() => Promise<{ data: { user: { id: string; email: string | null } | null } }>>();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
  }),
}));

// Admin supabase: model the chains used by the checkout route.
//
//   .from('profiles').select('id, stripe_customer_id').eq('id', userId).maybeSingle()
//   .from('profiles').update(patch).eq('id', userId)                              // legacy
//   .from('profiles').update(patch).eq('id', userId).is('stripe_customer_id', null).select('id')   // B6
//   .from('profiles').select('stripe_customer_id').eq('id', userId).maybeSingle() // B6 reread
type ProfileSelectResult = {
  data:
    | { id: string; stripe_customer_id: string | null }
    | { stripe_customer_id: string | null }
    | null;
  error: null | { message: string };
};
type ConditionalUpdateResult = {
  data: Array<{ id: string }> | null;
  error: null | { message: string };
};

const maybeSingleQueue: ProfileSelectResult[] = [];
const conditionalUpdateQueue: ConditionalUpdateResult[] = [];

const maybeSingleMock = vi.fn(async (): Promise<ProfileSelectResult> => {
  return (
    maybeSingleQueue.shift() ?? {
      data: null,
      error: { message: 'mock not configured' },
    }
  );
});

const updateEqMock = vi.fn<() => Promise<{ error: null | { message: string } }>>();
const updateMock = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: () => maybeSingleMock(),
        }),
      }),
      update: (patch: unknown) => {
        updateMock(patch);
        const eqResult = {
          // Legacy direct await: `.update().eq()` → `{ error }`
          then(resolve: (v: { error: null | { message: string } }) => void) {
            updateEqMock().then(resolve);
          },
          // B6 conditional path: `.update().eq().is().select(...)`
          is(_col: string, _val: unknown) {
            return {
              select(_sel: string) {
                return Promise.resolve(
                  conditionalUpdateQueue.shift() ?? {
                    data: [{ id: 'profile_default' }],
                    error: null,
                  },
                );
              },
            };
          },
        };
        return {
          eq: () => eqResult,
        };
      },
    }),
  }),
}));

const customersCreateMock =
  vi.fn<(args: { email?: string; metadata?: Record<string, string> }) => Promise<{ id: string }>>();
const customersDelMock = vi.fn<(id: string) => Promise<{ id: string; deleted: boolean }>>();
const sessionsCreateMock =
  vi.fn<(args: Record<string, unknown>) => Promise<{ url: string | null }>>();

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    customers: {
      create: (args: Parameters<typeof customersCreateMock>[0]) => customersCreateMock(args),
      del: (id: string) => customersDelMock(id),
    },
    checkout: {
      sessions: {
        create: (args: Parameters<typeof sessionsCreateMock>[0]) => sessionsCreateMock(args),
      },
    },
  }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000///',
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
  maybeSingleMock.mockClear();
  maybeSingleQueue.length = 0;
  conditionalUpdateQueue.length = 0;
  updateMock.mockClear();
  updateEqMock.mockReset();
  customersCreateMock.mockReset();
  customersDelMock.mockReset();
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
    maybeSingleQueue.push({
      data: { id: 'user_1', stripe_customer_id: 'cus_existing' },
      error: null,
    });

    const res = await POST(makeRequest({ mode: 'lifetime' }));
    expect(res.status).toBe(400);
  });

  it('creates a Stripe customer when the profile has none, then creates a session', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user_1', email: 'u@example.com' } },
    });
    maybeSingleQueue.push({
      data: { id: 'user_1', stripe_customer_id: null },
      error: null,
    });
    customersCreateMock.mockResolvedValue({ id: 'cus_new' });
    // The conditional update wins (1 row matched).
    conditionalUpdateQueue.push({ data: [{ id: 'user_1' }], error: null });
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

    // No orphan to clean up — we won the race.
    expect(customersDelMock).not.toHaveBeenCalled();

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
    expect(params['success_url']).toBe('http://localhost:3000/dashboard?checkout=success');
    expect(params['cancel_url']).toBe('http://localhost:3000/pricing');
    expect(params['line_items']).toEqual([{ price: 'price_one_time_test', quantity: 1 }]);
  });

  it('reuses an existing customer id and creates a subscription session', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user_2', email: 'u2@example.com' } },
    });
    maybeSingleQueue.push({
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
    expect(params['line_items']).toEqual([{ price: 'price_sub_test', quantity: 1 }]);
  });

  it('returns { url } in the success body', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user_3', email: 'u3@example.com' } },
    });
    maybeSingleQueue.push({
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

  // --- B6: concurrent customer-creation race -------------------------------

  it('B6: when a concurrent writer wins, deletes our orphan customer and reuses the winner', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user_race', email: 'race@example.com' } },
    });
    // Initial profile read: no customer id (we think we're first).
    maybeSingleQueue.push({
      data: { id: 'user_race', stripe_customer_id: null },
      error: null,
    });
    // Stripe customer is created.
    customersCreateMock.mockResolvedValue({ id: 'cus_loser' });
    // Conditional update affects 0 rows — the racing writer beat us.
    conditionalUpdateQueue.push({ data: [], error: null });
    // Re-read profile sees the winning id.
    maybeSingleQueue.push({
      data: { stripe_customer_id: 'cus_winner' },
      error: null,
    });
    customersDelMock.mockResolvedValue({ id: 'cus_loser', deleted: true });
    sessionsCreateMock.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/sess_race',
    });

    const res = await POST(makeRequest({ mode: 'one_time' }));
    expect(res.status).toBe(200);

    // The orphan customer (the one we just created) was deleted.
    expect(customersDelMock).toHaveBeenCalledTimes(1);
    expect(customersDelMock).toHaveBeenCalledWith('cus_loser');

    // The session was created with the winning customer id.
    const params = sessionsCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['customer']).toBe('cus_winner');
  });

  it('B6: only one customer ends up associated with the profile across two concurrent calls', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user_dual', email: 'dual@example.com' } },
    });

    // First call: no customer id.
    maybeSingleQueue.push({
      data: { id: 'user_dual', stripe_customer_id: null },
      error: null,
    });
    // Second call: also no customer id (both sides see null at read time).
    maybeSingleQueue.push({
      data: { id: 'user_dual', stripe_customer_id: null },
      error: null,
    });

    // Two customers get created concurrently.
    customersCreateMock
      .mockResolvedValueOnce({ id: 'cus_a' })
      .mockResolvedValueOnce({ id: 'cus_b' });

    // First conditional update wins (1 row), second loses (0 rows).
    conditionalUpdateQueue.push({ data: [{ id: 'user_dual' }], error: null });
    conditionalUpdateQueue.push({ data: [], error: null });

    // The losing path re-reads the profile and sees the winner.
    maybeSingleQueue.push({
      data: { stripe_customer_id: 'cus_a' },
      error: null,
    });

    customersDelMock.mockResolvedValue({ id: 'cus_b', deleted: true });

    sessionsCreateMock.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/sess_ok',
    });

    // Run both concurrently — order of resolution mirrors queue order.
    const [resA, resB] = await Promise.all([
      POST(makeRequest({ mode: 'one_time' })),
      POST(makeRequest({ mode: 'one_time' })),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Exactly one orphan (cus_b) was deleted; cus_a remains the canonical id.
    expect(customersDelMock).toHaveBeenCalledTimes(1);
    expect(customersDelMock).toHaveBeenCalledWith('cus_b');

    // Both sessions were created against the SAME winning customer id.
    const customers = sessionsCreateMock.mock.calls.map(
      (call) => (call[0] as Record<string, unknown>)['customer'],
    );
    expect(customers).toEqual(['cus_a', 'cus_a']);
  });
});
