import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/settings/inbound-token — mint or revoke the per-user
 * inbound webhook token used by /api/inbound/finding-status.
 *
 * Security properties:
 *   - Plaintext token only crosses the RSC boundary on the generate path,
 *     and only in the response body (never logged).
 *   - Revoke nulls the column; subsequent inbound webhook calls fail closed.
 *   - The unique-index collision path retries up to 3 times — with 192 bits
 *     of entropy the loop never triggers in practice, but a 3-attempt cap
 *     prevents a buggy DB constraint from spinning forever.
 */

const USER_ID = '33333333-3333-4333-8333-333333333333';

const { getUserMock, updateMock, generateTokenMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  updateMock: vi.fn(),
  generateTokenMock: vi.fn(),
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

vi.mock('@/lib/inbound/webhook-token', () => ({
  generateInboundWebhookToken: generateTokenMock,
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

import { POST } from '@/app/api/settings/inbound-token/route';

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/settings/inbound-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === '__raw_malformed__' ? '{not json' : JSON.stringify(body),
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  updateMock.mockReset();
  generateTokenMock.mockReset();
  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID } },
    error: null,
  });
  updateMock.mockResolvedValue({ error: null });
  generateTokenMock.mockReturnValue('whsec_fresh_token_value');
});

describe('POST /api/settings/inbound-token — auth', () => {
  it('returns 401 when no session', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(makeReq({ action: 'generate' }));
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
    expect(generateTokenMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/inbound-token — body validation', () => {
  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeReq('__raw_malformed__'));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when action is missing', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 when action is not in the enum', async () => {
    const res = await POST(makeReq({ action: 'reset' }));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/inbound-token — generate', () => {
  it('mints a fresh token, persists it, and returns the plaintext in the response', async () => {
    const res = await POST(makeReq({ action: 'generate' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBe('whsec_fresh_token_value');

    expect(generateTokenMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.inbound_webhook_token).toBe('whsec_fresh_token_value');
    expect(typeof payload.updated_at).toBe('string');
  });

  it('retries on 23505 unique-index collision (up to 3 attempts)', async () => {
    updateMock
      .mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } })
      .mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } })
      .mockResolvedValueOnce({ error: null });
    generateTokenMock.mockReturnValueOnce('t1').mockReturnValueOnce('t2').mockReturnValueOnce('t3');

    const res = await POST(makeReq({ action: 'generate' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toBe('t3');
    expect(generateTokenMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after 3 collision retries with a 500', async () => {
    updateMock.mockResolvedValue({
      error: { code: '23505', message: 'unique' },
    });
    const res = await POST(makeReq({ action: 'generate' }));
    expect(res.status).toBe(500);
    expect(generateTokenMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on a non-23505 error (returns 500 immediately)', async () => {
    updateMock.mockResolvedValueOnce({
      error: { code: '42703', message: 'column does not exist' },
    });
    const res = await POST(makeReq({ action: 'generate' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Could not generate token.');
    // Sensitive error detail must NOT leak.
    expect(body.error).not.toContain('column');
    expect(generateTokenMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/settings/inbound-token — revoke', () => {
  it('nulls the inbound_webhook_token column and returns ok:true (no token in response)', async () => {
    const res = await POST(makeReq({ action: 'revoke' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token?: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBeUndefined();

    const payload = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.inbound_webhook_token).toBeNull();
    expect(generateTokenMock).not.toHaveBeenCalled();
  });

  it('returns 500 with a generic message when the DB update fails on revoke', async () => {
    updateMock.mockResolvedValueOnce({
      error: { code: '08000', message: 'connection error' },
    });
    const res = await POST(makeReq({ action: 'revoke' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Could not revoke token.');
    expect(body.error).not.toContain('connection');
  });
});
