import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks --------------------------------------------------------------
// Regression tests for H1: when createSignedUploadUrl fails after a credit
// has been decremented, the credit must be refunded. Subscription users
// never consumed a credit and must NOT get a refund.

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

type InsertResult = { data: unknown; error: null | { message: string } };
type DeleteResult = { data: null; error: null | { message: string } };
type SignedUrlResult = {
  data: { signedUrl: string; token: string; path: string } | null;
  error: null | { message: string };
};
type RpcResult = { data: unknown; error: null | { message: string } };
type GateResult =
  | { ok: true; reason: 'subscription' }
  | { ok: true; reason: 'credit'; remaining: number }
  | { ok: false; reason: 'no_plan' | 'past_due' };

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const auditsInsertMock = vi.fn<(row: unknown) => Promise<InsertResult>>();
const auditsDeleteEqMock = vi.fn<() => Promise<DeleteResult>>(async () => ({
  data: null,
  error: null,
}));
const createSignedUploadUrlMock =
  vi.fn<(path: string) => Promise<SignedUrlResult>>();

const auditsUpdateMock = vi.fn(async () => ({ data: [{ id: 'audit-1' }], error: null }));

const fromMock = vi.fn((_table: string) => ({
  insert: (row: unknown) => auditsInsertMock(row),
  delete: () => ({
    eq: () => auditsDeleteEqMock(),
  }),
  update: (_patch: unknown) => ({
    eq: (_col: string, _val: string) => ({
      eq: (_col2: string, _val2: string) => auditsUpdateMock(),
    }),
  }),
}));

const storageFromMock = vi.fn((_bucket: string) => ({
  createSignedUploadUrl: (path: string) => createSignedUploadUrlMock(path),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: () => getUserMock(),
    },
  }),
}));

const gateMock = vi.fn<() => Promise<GateResult>>();
vi.mock('@/lib/access/gate', () => ({
  assertCanRunAudit: () => gateMock(),
}));

const decrementMock = vi.fn<
  (
    userId: string,
    auditId: string,
  ) => Promise<{ remaining: number; idempotent: boolean }>
>();
vi.mock('@/lib/access/decrement', () => ({
  consumeAuditCreditForAudit: (userId: string, auditId: string) =>
    decrementMock(userId, auditId),
}));

const adminRpcMock =
  vi.fn<(name: string, args: Record<string, unknown>) => Promise<RpcResult>>();
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    rpc: adminRpcMock,
    from: fromMock,
    storage: { from: storageFromMock },
  }),
}));

const sentryCaptureMock = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => sentryCaptureMock(...args),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

// Import after mocks are registered.
import { POST } from '@/app/api/audits/route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/audits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  auditsInsertMock.mockReset();
  auditsDeleteEqMock.mockClear();
  createSignedUploadUrlMock.mockReset();
  fromMock.mockClear();
  storageFromMock.mockClear();
  gateMock.mockReset();
  decrementMock.mockReset();
  decrementMock.mockResolvedValue({ remaining: 0, idempotent: false });
  adminRpcMock.mockReset();
  sentryCaptureMock.mockReset();

  getUserMock.mockResolvedValue({
    data: { user: { id: 'user-uuid-1', email: 'test@example.com' } },
    error: null,
  });
  auditsInsertMock.mockResolvedValue({ data: null, error: null });
  // Default: signed-URL creation FAILS — every test in this file exercises
  // the failure path; happy-path coverage lives in api.test.ts.
  createSignedUploadUrlMock.mockResolvedValue({
    data: null,
    error: { message: 'storage offline' },
  });
});

describe('POST /api/audits — credit refund on signed-URL failure (H1)', () => {
  it('refunds credit when signed-URL creation fails for a credit user', async () => {
    gateMock.mockResolvedValue({ ok: true, reason: 'credit', remaining: 3 });
    adminRpcMock.mockResolvedValue({ data: 1, error: null });

    const res = await POST(
      makeRequest({ filename: 'bill.pdf', fileSize: 12345 }),
    );

    expect(res.status).toBe(500);
    expect(decrementMock).toHaveBeenCalledTimes(1);
    expect(adminRpcMock).toHaveBeenCalledTimes(1);
    expect(adminRpcMock).toHaveBeenCalledWith('increment_audit_credits', {
      profile_id: 'user-uuid-1',
      delta: 1,
    });
    // Audit row was deleted as part of cleanup.
    expect(auditsDeleteEqMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT refund when the user is on an active subscription', async () => {
    gateMock.mockResolvedValue({ ok: true, reason: 'subscription' });

    const res = await POST(
      makeRequest({ filename: 'bill.pdf', fileSize: 12345 }),
    );

    expect(res.status).toBe(500);
    // Subscription users never consumed a credit, so neither path runs.
    expect(decrementMock).not.toHaveBeenCalled();
    expect(adminRpcMock).not.toHaveBeenCalled();
  });

  it('reports returned delete errors while cleaning up a signed-URL orphan', async () => {
    gateMock.mockResolvedValue({ ok: true, reason: 'subscription' });
    auditsDeleteEqMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'delete denied' },
    });

    const res = await POST(
      makeRequest({ filename: 'bill.pdf', fileSize: 12345 }),
    );

    expect(res.status).toBe(500);
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentryCaptureMock.mock.calls[0] as [
      Error,
      { tags?: Record<string, unknown>; extra?: Record<string, unknown> },
    ];
    expect(err.message).toBe('delete denied');
    expect(ctx.tags?.['surface']).toBe(
      'audits.create.rollback_signed_url_orphan',
    );
    expect(ctx.extra?.['userId']).toBe('user-uuid-1');
  });

  it('returns 500 and reports to Sentry when refund itself fails', async () => {
    gateMock.mockResolvedValue({ ok: true, reason: 'credit', remaining: 1 });
    adminRpcMock.mockResolvedValue({
      data: null,
      error: { message: 'rpc unavailable' },
    });

    const res = await POST(
      makeRequest({ filename: 'bill.pdf', fileSize: 12345 }),
    );

    expect(res.status).toBe(500);
    expect(adminRpcMock).toHaveBeenCalledTimes(1);
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentryCaptureMock.mock.calls[0] as [
      Error,
      { tags?: Record<string, unknown>; extra?: Record<string, unknown> },
    ];
    expect(err).toBeInstanceOf(Error);
    expect(ctx.tags?.['surface']).toBe('audits.create.refund');
    expect(ctx.extra?.['userId']).toBe('user-uuid-1');
  });
});
