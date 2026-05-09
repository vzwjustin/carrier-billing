import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';

// --- Mocks --------------------------------------------------------------
//
// C2 — round-trip the real Stripe SDK through the webhook handler so we
// catch any drift in our signature-verification path. Only the Supabase
// admin client is mocked; signature verification uses the real
// `stripe.webhooks.constructEvent` against a real `stripe.webhooks.generateTestHeaderString`.

// vi.mock factories are hoisted to the top of the file, so any constants they
// reference must be wrapped in `vi.hoisted` to also hoist with them.
const { TEST_WEBHOOK_SECRET, realStripe } = vi.hoisted(() => {
  // Top-level imports aren't hoisted, so we have to require Stripe here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const StripeCtor = require('stripe').default as typeof Stripe;
  return {
    TEST_WEBHOOK_SECRET: 'whsec_test_xxx_signature_test',
    realStripe: new StripeCtor('sk_test_dummy', {
      apiVersion: '2025-02-24.acacia',
      typescript: true,
    }),
  };
});

// The route reads `env.STRIPE_WEBHOOK_SECRET`, so stub via `vi.mock`.
// We can't use the test-only env var without `vi.stubEnv` because the env
// module is created at import time; the existing tests use `vi.mock('@/env')`.
vi.mock('@/env', () => ({
  env: {
    STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    STRIPE_SECRET_KEY: 'sk_test_dummy',
  },
}));

// Mock the lazy stripe client so it just delegates to a real Stripe instance
// constructed with a dummy key — we only call `webhooks.constructEvent` which
// doesn't make a network request, so the dummy key is fine.
vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => realStripe,
}));

// Supabase admin: minimal shape for the webhook's idempotency check + insert.
const insertMock = vi.fn(async (_row: unknown) => ({ data: null, error: null }));
const maybeSingleMock = vi.fn(async () => ({ data: null, error: null }));
const updateMock = vi.fn(async () => ({ data: null, error: null }));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => maybeSingleMock() }),
      }),
      insert: (row: unknown) => insertMock(row),
      update: (_row: unknown) => ({
        eq: () => updateMock(),
      }),
    }),
  }),
}));

// Stub the handler so we don't need a full Supabase mock for downstream logic.
vi.mock('@/lib/stripe/handlers', () => ({
  handleStripeEvent: vi.fn(async () => undefined),
}));

// Import after mocks are registered.
import { POST } from '@/app/api/stripe/webhook/route';

function buildSignedRequest(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = realStripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: TEST_WEBHOOK_SECRET,
    timestamp,
  });
  return {
    body,
    signature,
    request: new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body,
    }),
  };
}

beforeEach(() => {
  insertMock.mockClear();
  insertMock.mockImplementation(async () => ({ data: null, error: null }));
  maybeSingleMock.mockClear();
  maybeSingleMock.mockImplementation(async () => ({ data: null, error: null }));
  updateMock.mockClear();
  updateMock.mockImplementation(async () => ({ data: null, error: null }));
});

describe('POST /api/stripe/webhook — real Stripe signature verification (C2)', () => {
  it('accepts a payload signed with the configured secret (200, processed)', async () => {
    const payload = {
      id: 'evt_signed_ok',
      object: 'event',
      type: 'invoice.payment_failed',
      api_version: '2025-02-24',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'in_signed_ok', customer: 'cus_signed_ok' } },
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
    } satisfies Record<string, unknown>;

    const { request } = buildSignedRequest(payload);
    const res = await POST(request);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);

    // Confirm the event was actually persisted (i.e. signature passed and
    // the route reached the insert stage).
    expect(insertMock).toHaveBeenCalledTimes(1);
    const inserted = insertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted['stripe_event_id']).toBe('evt_signed_ok');
    expect(inserted['type']).toBe('invoice.payment_failed');
  });

  it('rejects with 400 when the body is tampered with after signing', async () => {
    const payload = {
      id: 'evt_tampered',
      object: 'event',
      type: 'invoice.payment_failed',
      api_version: '2025-02-24',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'in_tampered', customer: 'cus_tampered' } },
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
    } satisfies Record<string, unknown>;

    const { signature } = buildSignedRequest(payload);

    // Tamper: same signature, but a body that wasn't what we signed.
    const tamperedBody = JSON.stringify({ ...payload, id: 'evt_tampered_NEW' });
    const tamperedRequest = new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body: tamperedBody,
    });

    const res = await POST(tamperedRequest);
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the signature header is missing', async () => {
    const body = JSON.stringify({ id: 'evt_x', type: 'invoice.payment_failed' });
    const request = new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      body,
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });
});
