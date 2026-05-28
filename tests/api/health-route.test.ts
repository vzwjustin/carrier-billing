import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for GET /api/health.
 *
 * Two modes:
 *   - liveness (default): anonymous, 200 with checks.app:ok
 *   - deep (gated by HEALTH_SECRET): probes DB + Stripe + Anthropic
 *
 * Critical security properties:
 *   - Deep mode requires a constant-time token comparison
 *   - Unauthenticated deep requests must NOT reveal whether the secret is set
 *     vs. just wrong — both branches return 404 (or 200/skipped if secret
 *     unset) without exposing the actual secret state
 *   - Deep mode never burns Anthropic API credit (presence check only)
 */

const stripeBalanceRetrieve = vi.hoisted(() => vi.fn());
const supabaseSelectMock = vi.hoisted(() => vi.fn());

let healthSecret: string | undefined;
let anthropicKey: string | undefined = 'sk-ant-test-1234567890';

vi.mock('@/env', () => ({
  get env() {
    return {
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      STRIPE_SECRET_KEY: 'sk_test',
      HEALTH_SECRET: healthSecret,
      ANTHROPIC_API_KEY: anthropicKey,
    };
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      select: supabaseSelectMock,
    }),
  }),
}));

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    balance: { retrieve: stripeBalanceRetrieve },
  }),
}));

const { GET } = await import('@/app/api/health/route');

beforeEach(() => {
  healthSecret = undefined;
  anthropicKey = 'sk-ant-test-1234567890';
  stripeBalanceRetrieve.mockReset();
  supabaseSelectMock.mockReset();
  supabaseSelectMock.mockReturnValue({
    limit: async () => ({ error: null, count: 0 }),
  });
  stripeBalanceRetrieve.mockResolvedValue({ available: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/health — liveness mode (anonymous)', () => {
  it('returns 200 with mode:"liveness" when no token or ?deep param', async () => {
    const res = await GET(new Request('http://localhost/api/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      mode: string;
      checks: Record<string, { status: string }>;
    };
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('liveness');
    expect(body.checks.app?.status).toBe('ok');
    // Liveness must NOT include deep-only checks.
    expect(body.checks).not.toHaveProperty('db');
    expect(body.checks).not.toHaveProperty('stripe');
    expect(body.checks).not.toHaveProperty('anthropic');
  });

  it('does NOT touch Stripe or the DB in liveness mode', async () => {
    await GET(new Request('http://localhost/api/health'));
    expect(stripeBalanceRetrieve).not.toHaveBeenCalled();
    expect(supabaseSelectMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/health — deep mode gating', () => {
  it('returns "degraded" + skipped:HEALTH_SECRET-not-configured when secret env is unset', async () => {
    healthSecret = undefined;
    const res = await GET(new Request('http://localhost/api/health?deep=1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string; detail?: string }>;
    };
    expect(body.status).toBe('degraded');
    expect(body.checks.deep?.status).toBe('skipped');
    expect(body.checks.deep?.detail).toContain('HEALTH_SECRET');
  });

  it('returns 404 when a token is provided but does not match HEALTH_SECRET', async () => {
    healthSecret = 'correct-secret-value';
    const res = await GET(
      new Request('http://localhost/api/health?token=wrong-secret-value'),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when no token is provided and HEALTH_SECRET is set (no probing without auth)', async () => {
    healthSecret = 'correct-secret-value';
    // Note: ?deep=1 alone without token MUST fail when secret is set.
    const res = await GET(new Request('http://localhost/api/health?deep=1'));
    expect(res.status).toBe(404);
  });

  it('proceeds when the token matches HEALTH_SECRET exactly', async () => {
    healthSecret = 'correct-secret-value';
    const res = await GET(
      new Request('http://localhost/api/health?token=correct-secret-value'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      checks: Record<string, unknown>;
    };
    expect(body.mode).toBe('deep');
    expect(body.checks).toHaveProperty('db');
    expect(body.checks).toHaveProperty('stripe');
    expect(body.checks).toHaveProperty('anthropic');
  });

  it('rejects a token of the wrong length even if it is a prefix of the real secret (constant-time compare)', async () => {
    healthSecret = 'correct-secret-value';
    const res = await GET(
      new Request('http://localhost/api/health?token=correct-secret'),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/health — deep checks', () => {
  beforeEach(() => {
    healthSecret = 'test-secret';
  });

  it('reports db:ok when supabase returns no error', async () => {
    supabaseSelectMock.mockReturnValue({
      limit: async () => ({ error: null, count: 1 }),
    });
    const res = await GET(
      new Request('http://localhost/api/health?token=test-secret'),
    );
    const body = (await res.json()) as { checks: Record<string, { status: string }> };
    expect(body.checks.db?.status).toBe('ok');
  });

  it('reports db:fail with truncated detail when supabase errors', async () => {
    supabaseSelectMock.mockReturnValue({
      limit: async () => ({ error: { message: 'X'.repeat(500) }, count: null }),
    });
    const res = await GET(
      new Request('http://localhost/api/health?token=test-secret'),
    );
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string; detail?: string }>;
    };
    expect(body.checks.db?.status).toBe('fail');
    expect(body.checks.db?.detail?.length).toBeLessThanOrEqual(120);
    expect(body.status).toBe('degraded');
  });

  it('reports stripe:fail when balance.retrieve throws', async () => {
    stripeBalanceRetrieve.mockRejectedValue(new Error('network error'));
    const res = await GET(
      new Request('http://localhost/api/health?token=test-secret'),
    );
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string; detail?: string }>;
    };
    expect(body.checks.stripe?.status).toBe('fail');
    expect(body.checks.stripe?.detail).toContain('network error');
    expect(body.status).toBe('degraded');
  });

  it('reports anthropic:ok when ANTHROPIC_API_KEY is set (and never calls the API)', async () => {
    anthropicKey = 'sk-ant-real-key';
    const res = await GET(
      new Request('http://localhost/api/health?token=test-secret'),
    );
    const body = (await res.json()) as {
      checks: Record<string, { status: string }>;
    };
    expect(body.checks.anthropic?.status).toBe('ok');
    // Critical: this check must not burn a real API call. We don't mock the
    // SDK so any call would error in tests; an "ok" response proves no call.
  });

  it('reports anthropic:fail when ANTHROPIC_API_KEY is missing', async () => {
    anthropicKey = undefined;
    const res = await GET(
      new Request('http://localhost/api/health?token=test-secret'),
    );
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string; detail?: string }>;
    };
    expect(body.checks.anthropic?.status).toBe('fail');
    expect(body.checks.anthropic?.detail).toBe('missing');
    expect(body.status).toBe('degraded');
  });

  it('returns status:ok when ALL three checks pass', async () => {
    supabaseSelectMock.mockReturnValue({
      limit: async () => ({ error: null, count: 0 }),
    });
    stripeBalanceRetrieve.mockResolvedValue({ available: [] });
    anthropicKey = 'sk-ant-real-key';

    const res = await GET(
      new Request('http://localhost/api/health?token=test-secret'),
    );
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});
