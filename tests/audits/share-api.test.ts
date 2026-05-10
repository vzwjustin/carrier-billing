import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Types ------------------------------------------------------------------

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

type AuditTokenRow = {
  id: string;
  user_id: string;
  share_token: string | null;
  share_token_expires_at: string | null;
};

type MaybeSingleResult =
  | { data: AuditTokenRow; error: null }
  | { data: null; error: null }
  | { data: null; error: { message: string } };

// --- Mocks ------------------------------------------------------------------

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const maybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();
const updateEqMock = vi.fn<() => Promise<{ data: null; error: null | { message: string } }>>();

const eqSelectMock = vi.fn(() => ({
  maybeSingle: () => maybeSingleMock(),
}));

const selectMock = vi.fn((_cols: string) => ({
  eq: (_col: string, _val: string) => eqSelectMock(),
}));

const updateMock = vi.fn((_row: Record<string, unknown>) => ({
  eq: (_col: string, _val: string) => updateEqMock(),
}));

const fromMock = vi.fn((_table: string) => ({
  select: (cols: string) => selectMock(cols),
  update: (row: Record<string, unknown>) => updateMock(row),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: () => getUserMock(),
    },
    from: fromMock,
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: fromMock,
  }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    NEXT_PUBLIC_APP_URL: 'https://app.carrieraudit.test',
  },
}));

// Import after mocks are registered.
import { DELETE, POST } from '@/app/api/audits/[id]/share/route';

const VALID_AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_USER_ID = 'user-uuid-1';

function makeContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): Request {
  return new Request(`http://localhost/api/audits/${VALID_AUDIT_ID}/share`, {
    method: 'POST',
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  maybeSingleMock.mockReset();
  updateEqMock.mockReset();
  eqSelectMock.mockClear();
  selectMock.mockClear();
  updateMock.mockClear();
  fromMock.mockClear();

  getUserMock.mockResolvedValue({
    data: { user: { id: OWNER_USER_ID, email: 'test@example.com' } },
    error: null,
  });
  updateEqMock.mockResolvedValue({ data: null, error: null });
});

describe('POST /api/audits/[id]/share', () => {
  it('returns 401 when there is no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the audit id is not a uuid', async () => {
    const res = await POST(makeRequest(), makeContext('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the audit row is not found', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the audit row is owned by another user (M-A1)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: 'someone-else',
        share_token: null,
        share_token_expires_at: null,
      },
      error: null,
    });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('generates a new token AND an expiry when the audit has no share_token (H11)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        share_token: null,
        share_token_expires_at: null,
      },
      error: null,
    });
    const before = Date.now();
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(200);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const updateArg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const generatedToken = updateArg['share_token'];
    expect(typeof generatedToken).toBe('string');
    // Generator emits exactly 32 chars of base64url (24 random bytes).
    expect((generatedToken as string).length).toBe(32);

    // Expiry must be set ~30 days in the future.
    const expiresAt = updateArg['share_token_expires_at'];
    expect(typeof expiresAt).toBe('string');
    const expiryMs = Date.parse(expiresAt as string);
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiryMs - before).toBeGreaterThan(thirtyDaysMs - 5_000);
    expect(expiryMs - before).toBeLessThan(thirtyDaysMs + 5_000);

    const json = (await res.json()) as Record<string, unknown>;
    expect(typeof json['url']).toBe('string');
    expect(json['url']).toBe(`https://app.carrieraudit.test/share/${generatedToken as string}`);
  });

  it('returns the existing token without regenerating when one is still valid', async () => {
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        share_token: 'existing-token-123',
        share_token_expires_at: futureExpiry,
      },
      error: null,
    });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(200);

    // Update is invoked to refresh the expiry, but the share_token field
    // should NOT be in the update payload (we're keeping the same token).
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['share_token']).toBeUndefined();
    expect(typeof arg['share_token_expires_at']).toBe('string');

    const json = (await res.json()) as Record<string, unknown>;
    expect(json['url']).toBe('https://app.carrieraudit.test/share/existing-token-123');
  });

  it('regenerates the token when the existing one has expired (H11)', async () => {
    const pastExpiry = new Date(Date.now() - 1_000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        share_token: 'stale-token',
        share_token_expires_at: pastExpiry,
      },
      error: null,
    });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(200);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const newToken = arg['share_token'];
    expect(typeof newToken).toBe('string');
    expect(newToken).not.toBe('stale-token');
    expect(typeof arg['share_token_expires_at']).toBe('string');
  });
});

describe('DELETE /api/audits/[id]/share', () => {
  it('returns 204 and nulls out share_token + share_token_expires_at (H11 revocation)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        share_token: 'live-token',
        share_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
    });
    const req = new Request(`http://localhost/api/audits/${VALID_AUDIT_ID}/share`, {
      method: 'DELETE',
    });
    const res = await DELETE(req, makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(204);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['share_token']).toBeNull();
    expect(arg['share_token_expires_at']).toBeNull();
  });

  it('returns 401 when there is no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const req = new Request(`http://localhost/api/audits/${VALID_AUDIT_ID}/share`, {
      method: 'DELETE',
    });
    const res = await DELETE(req, makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the audit is owned by another user (M-A1)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: 'someone-else',
        share_token: 'live-token',
        share_token_expires_at: null,
      },
      error: null,
    });
    const req = new Request(`http://localhost/api/audits/${VALID_AUDIT_ID}/share`, {
      method: 'DELETE',
    });
    const res = await DELETE(req, makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the audit is not found', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const req = new Request(`http://localhost/api/audits/${VALID_AUDIT_ID}/share`, {
      method: 'DELETE',
    });
    const res = await DELETE(req, makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the audit id is not a uuid', async () => {
    const req = new Request(`http://localhost/api/audits/foo/share`, {
      method: 'DELETE',
    });
    const res = await DELETE(req, makeContext('not-a-uuid'));
    expect(res.status).toBe(400);
  });
});
