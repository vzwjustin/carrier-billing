import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Types ------------------------------------------------------------------

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

type AuditTokenRow = {
  id: string;
  user_id: string;
  status: string;
  share_token: string | null;
  share_token_expires_at: string | null;
};

type MaybeSingleResult =
  | { data: AuditTokenRow; error: null }
  | { data: null; error: null }
  | { data: null; error: { message: string } };
type UpdateResult =
  | { data: Array<{ id: string }>; error: null }
  | { data: null; error: { message: string } };

// --- Mocks ------------------------------------------------------------------

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const maybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();
const updateEqMock = vi.fn<() => Promise<UpdateResult>>();
const updateFilters: Array<[string, unknown]> = [];

const eqSelectMock = vi.fn(() => ({
  maybeSingle: () => maybeSingleMock(),
}));

const selectMock = vi.fn((_cols: string) => ({
  eq: (_col: string, _val: string) => eqSelectMock(),
}));

const updateMock = vi.fn((_row: Record<string, unknown>) => {
  const builder = {
    eq: (col: string, val: unknown) => {
      updateFilters.push([col, val]);
      return builder;
    },
    then: (
      onFulfilled: (value: UpdateResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => updateEqMock().then(onFulfilled, onRejected),
    select: (_cols: string) => updateEqMock(),
  };
  return builder;
});

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

const sentryCaptureMock = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => sentryCaptureMock(...args),
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
  updateFilters.length = 0;
  eqSelectMock.mockClear();
  selectMock.mockClear();
  updateMock.mockClear();
  fromMock.mockClear();
  sentryCaptureMock.mockReset();

  getUserMock.mockResolvedValue({
    data: { user: { id: OWNER_USER_ID, email: 'test@example.com' } },
    error: null,
  });
  updateEqMock.mockResolvedValue({ data: [{ id: VALID_AUDIT_ID }], error: null });
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
        status: 'completed',
        share_token: null,
        share_token_expires_at: null,
      },
      error: null,
    });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 409 without issuing a token when the audit is not completed', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        status: 'extracting',
        share_token: null,
        share_token_expires_at: null,
      },
      error: null,
    });

    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('audit_not_completed');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('generates a new token AND an expiry when the audit has no share_token (H11)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        status: 'completed',
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
    expect(updateFilters).toContainEqual(['id', VALID_AUDIT_ID]);
    expect(updateFilters).toContainEqual(['user_id', OWNER_USER_ID]);
    expect(updateFilters).toContainEqual(['status', 'completed']);
  });

  it('reports unexpected POST failures with a scrubbed message', async () => {
    getUserMock.mockRejectedValueOnce(new Error('boom for customer@example.com'));

    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));

    expect(res.status).toBe(500);
    const [err, ctx] = sentryCaptureMock.mock.calls[0] as [
      Error,
      { tags?: { surface?: string }; extra?: { auditId?: string } },
    ];
    expect(err.message).toContain('[email]');
    expect(err.message).not.toContain('customer@example.com');
    expect(ctx.tags?.surface).toBe('audits.share.post');
    expect(ctx.extra?.auditId).toBe(VALID_AUDIT_ID);
  });

  it('fails closed when the service-role token update matches no completed audit', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        status: 'completed',
        share_token: null,
        share_token_expires_at: null,
      },
      error: null,
    });
    updateEqMock.mockResolvedValueOnce({ data: [], error: null });

    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('audit_not_completed');
  });

  it('returns the existing token without regenerating when one is still valid', async () => {
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        status: 'completed',
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

  it('regenerates the token when expiry is NULL (legacy row without TTL)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        status: 'completed',
        share_token: 'legacy-token',
        share_token_expires_at: null,
      },
      error: null,
    });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(200);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof arg['share_token']).toBe('string');
    expect(arg['share_token']).not.toBe('legacy-token');
    expect(typeof arg['share_token_expires_at']).toBe('string');
  });

  it('regenerates the token when the existing one has expired (H11)', async () => {
    const pastExpiry = new Date(Date.now() - 1_000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        status: 'completed',
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
        status: 'completed',
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

  it('returns 404 when the service-role revoke update matches no audit', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_AUDIT_ID,
        user_id: OWNER_USER_ID,
        status: 'completed',
        share_token: 'live-token',
        share_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
    });
    updateEqMock.mockResolvedValueOnce({ data: [], error: null });
    const req = new Request(`http://localhost/api/audits/${VALID_AUDIT_ID}/share`, {
      method: 'DELETE',
    });

    const res = await DELETE(req, makeContext(VALID_AUDIT_ID));

    expect(res.status).toBe(404);
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
        status: 'completed',
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

  it('reports unexpected DELETE failures with a scrubbed message', async () => {
    getUserMock.mockRejectedValueOnce(new Error('boom for customer@example.com'));
    const req = new Request(`http://localhost/api/audits/${VALID_AUDIT_ID}/share`, {
      method: 'DELETE',
    });

    const res = await DELETE(req, makeContext(VALID_AUDIT_ID));

    expect(res.status).toBe(500);
    const [err, ctx] = sentryCaptureMock.mock.calls[0] as [
      Error,
      { tags?: { surface?: string }; extra?: { auditId?: string } },
    ];
    expect(err.message).toContain('[email]');
    expect(err.message).not.toContain('customer@example.com');
    expect(ctx.tags?.surface).toBe('audits.share.delete');
    expect(ctx.extra?.auditId).toBe(VALID_AUDIT_ID);
  });
});
