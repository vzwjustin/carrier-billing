import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/autopsy/drivers/[driverId]/explain.
 *
 * Owner-only toggle on bill_change_drivers.is_explained. Coverage:
 *   - 400 invalid uuid / malformed body / wrong body shape
 *   - 401 missing session
 *   - 404 when row is RLS-hidden or owned by a different user
 *   - 429 rate-limit
 *   - 200 happy path with explained=true sets explained_at + explained_by
 *   - 200 toggle to false nulls those columns
 *   - 500 on UPDATE error
 */

const USER_ID = '33333333-3333-4333-8333-333333333333';
const DRIVER_ID = '11111111-1111-4111-8111-111111111111';
const COMPARISON_ID = '22222222-2222-4222-8222-222222222222';

const {
  getUserMock,
  maybeSingleMock,
  updateMock,
  consumeRateLimitMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  maybeSingleMock: vi.fn(),
  updateMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: maybeSingleMock }),
      }),
    }),
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async () => updateMock(patch),
      }),
    }),
  }),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: consumeRateLimitMock,
  rateLimitedResponse: () => new Response('rate-limited', { status: 429 }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

import { POST } from '@/app/api/autopsy/drivers/[driverId]/explain/route';

function makeContext(
  driverId: string = DRIVER_ID,
): { params: Promise<{ driverId: string }> } {
  return { params: Promise.resolve({ driverId }) };
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/autopsy/drivers/x/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === '__raw_malformed__' ? '{not json' : JSON.stringify(body),
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  maybeSingleMock.mockReset();
  updateMock.mockReset();
  consumeRateLimitMock.mockReset();
  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID, email: 'u@example.com' } },
    error: null,
  });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    resetAt: new Date().toISOString(),
  });
  maybeSingleMock.mockResolvedValue({
    data: {
      id: DRIVER_ID,
      bill_comparison_id: COMPARISON_ID,
      bill_comparisons: { user_id: USER_ID },
    },
    error: null,
  });
  updateMock.mockResolvedValue({ error: null });
});

describe('POST /explain — validation', () => {
  it('returns 400 when driverId is not a uuid', async () => {
    const res = await POST(makeReq({ explained: true }), makeContext('bad'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeReq('__raw_malformed__'), makeContext());
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is missing explained', async () => {
    const res = await POST(makeReq({}), makeContext());
    expect(res.status).toBe(400);
  });

  it('returns 400 when explained is not a boolean', async () => {
    const res = await POST(makeReq({ explained: 'yes' }), makeContext());
    expect(res.status).toBe(400);
  });
});

describe('POST /explain — auth + ownership', () => {
  it('returns 401 when no session', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(makeReq({ explained: true }), makeContext());
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the driver row is RLS-hidden', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(makeReq({ explained: true }), makeContext());
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the joined comparison is owned by a different user', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: DRIVER_ID,
        bill_comparison_id: COMPARISON_ID,
        bill_comparisons: { user_id: 'someone-else' },
      },
      error: null,
    });
    const res = await POST(makeReq({ explained: true }), makeContext());
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /explain — rate limit', () => {
  it('uses a per-user rate-limit key', async () => {
    await POST(makeReq({ explained: true }), makeContext());
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as {
      key: string;
      limit: number;
    };
    expect(call.key).toBe(`autopsy-explain:${USER_ID}`);
    expect(call.limit).toBe(60);
  });

  it('returns 429 when rate-limit exhausted', async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      resetAt: new Date().toISOString(),
    });
    const res = await POST(makeReq({ explained: true }), makeContext());
    expect(res.status).toBe(429);
  });
});

describe('POST /explain — happy path', () => {
  it('sets is_explained=true plus explained_at and explained_by when toggling on', async () => {
    const res = await POST(makeReq({ explained: true }), makeContext());
    expect(res.status).toBe(200);
    const patch = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.is_explained).toBe(true);
    expect(typeof patch.explained_at).toBe('string');
    expect(patch.explained_by).toBe(USER_ID);
  });

  it('nulls explained_at and explained_by when toggling off', async () => {
    const res = await POST(makeReq({ explained: false }), makeContext());
    expect(res.status).toBe(200);
    const patch = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.is_explained).toBe(false);
    expect(patch.explained_at).toBeNull();
    expect(patch.explained_by).toBeNull();
  });

  it('returns 500 with a generic message when the UPDATE fails', async () => {
    updateMock.mockResolvedValueOnce({ error: { message: 'db down' } });
    const res = await POST(makeReq({ explained: true }), makeContext());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Failed to update driver.');
    expect(body.error).not.toContain('db down');
  });
});
