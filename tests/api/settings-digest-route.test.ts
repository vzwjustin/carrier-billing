import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/settings/digest — authenticated digest opt-in/out.
 *
 * Coverage:
 *   - 401 on missing session
 *   - 400 on malformed JSON / wrong body shape
 *   - 429 when rate-limit exhausted
 *   - 200 happy path — DB update with the expected payload
 *   - 500 on DB error (mapped to a generic message, no leak)
 */

const USER_ID = '33333333-3333-4333-8333-333333333333';

const { getUserMock, updateMock, consumeRateLimitMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  updateMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, _val: string) => updateMock(patch),
      }),
    }),
  }),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: consumeRateLimitMock,
  rateLimitedResponse: (resetAt: string) =>
    new Response('Too Many Requests', {
      status: 429,
      headers: { 'Retry-After': '60', 'X-Reset-At': resetAt },
    }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

import { POST } from '@/app/api/settings/digest/route';

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/settings/digest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === '__raw_malformed__' ? '{not json' : JSON.stringify(body),
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  updateMock.mockReset();
  consumeRateLimitMock.mockReset();
  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID } },
    error: null,
  });
  updateMock.mockResolvedValue({ error: null });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    resetAt: new Date().toISOString(),
  });
});

describe('POST /api/settings/digest — body validation', () => {
  it('returns 400 on malformed JSON before auth check', async () => {
    const res = await POST(makeReq('__raw_malformed__'));
    expect(res.status).toBe(400);
    expect(getUserMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when opt_out is missing', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when opt_out is not a boolean', async () => {
    const res = await POST(makeReq({ opt_out: 'yes' }));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/digest — auth', () => {
  it('returns 401 when no session', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(makeReq({ opt_out: true }));
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/digest — happy path', () => {
  it('flips digest_opt_out=true and returns ok:true', async () => {
    const res = await POST(makeReq({ opt_out: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; opt_out: boolean };
    expect(body.ok).toBe(true);
    expect(body.opt_out).toBe(true);

    const payload = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.digest_opt_out).toBe(true);
    expect(typeof payload.updated_at).toBe('string');
  });

  it('opts back in (digest_opt_out=false)', async () => {
    const res = await POST(makeReq({ opt_out: false }));
    expect(res.status).toBe(200);
    const payload = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.digest_opt_out).toBe(false);
  });
});

describe('POST /api/settings/digest — rate limit', () => {
  it('rate-limit key is per-userId (so one user cannot exhaust another)', async () => {
    await POST(makeReq({ opt_out: true }));
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as { key: string };
    expect(call.key).toBe(`settings-digest:${USER_ID}`);
  });

  it('returns 429 when rate-limit is exhausted', async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await POST(makeReq({ opt_out: true }));
    expect(res.status).toBe(429);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/digest — DB error', () => {
  it('returns 500 with a generic error when the UPDATE fails (no leak)', async () => {
    updateMock.mockResolvedValueOnce({
      error: { message: 'connection refused' },
    });
    const res = await POST(makeReq({ opt_out: true }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Failed to update preferences.');
    expect(body.error).not.toContain('connection');
  });
});
