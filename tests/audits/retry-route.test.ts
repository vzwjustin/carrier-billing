import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/audits/[id]/retry — covers H7 (stable Inngest
 * idempotency keys via CAS-incremented retry_count) and M-A3 (cached PDF
 * invalidation). The previous implementation anchored the Inngest event id
 * on `Date.now()`, which made every retry call (including browser retries)
 * fan out into independent worker runs.
 */

// ─── Types ─────────────────────────────────────────────────────────────────
type GetUserResult = {
  data: { user: { id: string } | null };
  error: null;
};

type AuditRow = {
  id: string;
  user_id: string;
  status: string;
  storage_path: string;
  retry_count: number;
  failure_reason: string | null;
  credit_consumed: boolean;
};

type AuditRowResp =
  | { data: AuditRow | null; error: null }
  | { data: null; error: { message: string } };

type UpdateResp =
  | { data: { retry_count: number }[]; error: null }
  | { data: never[]; error: null }
  | { data: null; error: { message: string } };
type NoSelectUpdateResp = { data: null; error: null | { message: string } };
type StorageRemoveResp = { data: null; error: null | { message: string } };

// ─── Mocks ─────────────────────────────────────────────────────────────────
const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const auditsSelectMock = vi.fn<() => Promise<AuditRowResp>>();
const inngestSendMock = vi.fn(async (_event: unknown) => undefined);

// admin: update().eq().eq().eq().select()
const adminUpdateSelectMock = vi.fn<() => Promise<UpdateResp>>();
const adminUpdateNoSelectMock = vi.fn<() => Promise<NoSelectUpdateResp>>();
const adminUpdateRows: Record<string, unknown>[] = [];
const adminUpdateFilters: Array<Array<[string, unknown]>> = [];

// admin: storage.from('reports').remove([...])
const storageRemoveMock = vi.fn<(_paths: string[]) => Promise<StorageRemoveResp>>(async () => ({
  data: null,
  error: null,
}));

const sentryCaptureMock = vi.fn();
const refundFailedAuditMock = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
  data: true,
  error: null,
}));

// server-client chain: from('audits').select(...).eq(...).maybeSingle()
function makeServerFromChain() {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: () => auditsSelectMock(),
      }),
    }),
  };
}

// admin-client chain. Two distinct shapes:
//  1. update(...).eq(...).eq(...).eq(...).select(...) → returns { data, error }
//  2. storage.from('reports').remove([...])
function makeAdminFromChain() {
  return {
    update: (row: Record<string, unknown>) => {
      adminUpdateRows.push(row);
      const filters: Array<[string, unknown]> = [];
      adminUpdateFilters.push(filters);
      const builder = {
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        select: (_cols: string) => adminUpdateSelectMock(),
        then: (
          resolve: (value: NoSelectUpdateResp) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => adminUpdateNoSelectMock().then(resolve, reject),
      };
      return builder;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
    from: (_table: string) => makeServerFromChain(),
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (_table: string) => makeAdminFromChain(),
    storage: {
      from: (_bucket: string) => ({
        remove: (paths: string[]) => storageRemoveMock(paths),
      }),
    },
    rpc: (name: string, args: Record<string, unknown>) => refundFailedAuditMock(name, args),
  }),
}));

vi.mock('@/inngest/client', () => ({
  inngest: { send: (event: unknown) => inngestSendMock(event) },
}));

import type { AccessGateResult } from '@/lib/access/gate';

const assertCanRunAuditMock = vi.fn<() => Promise<AccessGateResult>>();
const consumeAuditCreditMock =
  vi.fn<(userId: string, auditId: string) => Promise<{ remaining: number; idempotent: boolean }>>();

vi.mock('@/lib/access/gate', () => ({
  assertCanRunAudit: () => assertCanRunAuditMock(),
}));

vi.mock('@/lib/access/decrement', () => ({
  consumeAuditCreditForAudit: (userId: string, auditId: string) =>
    consumeAuditCreditMock(userId, auditId),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => sentryCaptureMock(...args),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

// Import after mocks register.
import { POST } from '@/app/api/audits/[id]/retry/route';

const TEST_AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

function makeContext() {
  return { params: Promise.resolve({ id: TEST_AUDIT_ID }) };
}

function makeFailedAudit(over: Partial<AuditRow> = {}): AuditRow {
  return {
    id: TEST_AUDIT_ID,
    user_id: TEST_USER_ID,
    status: 'failed',
    storage_path: `${TEST_USER_ID}/audit/bill.pdf`,
    retry_count: 0,
    failure_reason: 'extraction-timeout: 720000ms',
    credit_consumed: true,
    ...over,
  };
}

beforeEach(() => {
  getUserMock.mockReset();
  auditsSelectMock.mockReset();
  inngestSendMock.mockReset();
  adminUpdateSelectMock.mockReset();
  adminUpdateNoSelectMock.mockReset();
  adminUpdateRows.length = 0;
  adminUpdateFilters.length = 0;
  storageRemoveMock.mockClear();
  sentryCaptureMock.mockReset();
  assertCanRunAuditMock.mockReset();
  consumeAuditCreditMock.mockReset();
  refundFailedAuditMock.mockClear();

  getUserMock.mockResolvedValue({
    data: { user: { id: TEST_USER_ID } },
    error: null,
  });
  assertCanRunAuditMock.mockResolvedValue({ ok: true, reason: 'subscription' });
  consumeAuditCreditMock.mockResolvedValue({ remaining: 2, idempotent: false });
  // Sensible defaults: failed audit owned by the requester at retry_count=0.
  auditsSelectMock.mockResolvedValue({ data: makeFailedAudit(), error: null });
  // CAS update wins by default.
  adminUpdateSelectMock.mockResolvedValue({ data: [{ retry_count: 1 }], error: null });
  adminUpdateNoSelectMock.mockResolvedValue({ data: null, error: null });
});

describe('POST /api/audits/[id]/retry', () => {
  it('happy path: idempotency id is deterministic from retry_count (M-9)', async () => {
    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(200);

    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    const sent = inngestSendMock.mock.calls[0]?.[0] as {
      id?: string;
      name?: string;
      data?: { retryCount?: unknown };
    };
    expect(sent?.name).toBe('bill.uploaded');
    expect(sent?.id).toBe(`${TEST_AUDIT_ID}-uploaded-retry-1`);
    expect(sent?.data?.retryCount).toBe(1);
  });

  it('two retry POSTs racing → CAS loser returns 409 and does NOT enqueue', async () => {
    // First call: CAS update wins (returns one row).
    adminUpdateSelectMock.mockResolvedValueOnce({
      data: [{ retry_count: 1 }],
      error: null,
    });
    // Second call: CAS loses (no rows matched the previous retry_count).
    adminUpdateSelectMock.mockResolvedValueOnce({ data: [], error: null });

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const r1 = await POST(req, makeContext());
    const r2 = await POST(req, makeContext());

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(409);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it('cached PDF is removed before the audit row is reset (M-A3)', async () => {
    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(200);

    expect(storageRemoveMock).toHaveBeenCalledTimes(1);
    const paths = storageRemoveMock.mock.calls[0]?.[0];
    expect(paths).toEqual([`${TEST_AUDIT_ID}.pdf`]);
  });

  it('storage outage during PDF invalidation does not block retry (M-A3)', async () => {
    storageRemoveMock.mockRejectedValueOnce(new Error('boom'));

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(200);

    // The error must be reported to Sentry.
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    // And the Inngest event must still fire.
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it('reports returned storage errors during PDF invalidation', async () => {
    storageRemoveMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'storage remove failed' },
    });

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(200);

    const storageCall = sentryCaptureMock.mock.calls.find(
      ([, ctx]) =>
        (ctx as { tags?: { surface?: string } } | undefined)?.tags?.surface ===
        'audits.retry.storage_invalidate',
    );
    expect(storageCall).toBeTruthy();
    expect((storageCall?.[0] as { message?: string }).message).toBe('storage remove failed');
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back to failed with the original failure reason and incremented retry count when enqueue fails', async () => {
    inngestSendMock.mockRejectedValueOnce(new Error('inngest unavailable'));

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());

    expect(res.status).toBe(500);
    expect(adminUpdateRows).toHaveLength(2);
    expect(adminUpdateRows[0]?.['status']).toBe('pending');
    expect(adminUpdateRows[0]?.['failure_reason']).toBeNull();
    expect(adminUpdateRows[1]?.['status']).toBe('failed');
    expect(adminUpdateRows[1]?.['failure_reason']).toBe('extraction-timeout: 720000ms');
    expect(adminUpdateRows[1]?.['retry_count']).toBe(1);
    expect(adminUpdateFilters[1]).toContainEqual(['status', 'pending']);
    expect(adminUpdateFilters[1]).toContainEqual(['retry_count', 1]);
  });

  it('reports returned rollback errors after enqueue fails', async () => {
    inngestSendMock.mockRejectedValueOnce(new Error('inngest unavailable'));
    adminUpdateNoSelectMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'rollback write failed' },
    });

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());

    expect(res.status).toBe(500);
    const rollbackCall = sentryCaptureMock.mock.calls.find(
      ([, ctx]) =>
        (ctx as { tags?: { surface?: string } } | undefined)?.tags?.surface ===
        'audits.retry.rollback',
    );
    expect(rollbackCall).toBeTruthy();
    expect((rollbackCall?.[0] as Error).message).toBe(
      'Audit retry rollback failed: rollback write failed',
    );
  });

  it('returns 401 when there is no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(401);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the audit is owned by another user', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: makeFailedAudit({ user_id: 'someone-else' }),
      error: null,
    });
    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(404);
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(storageRemoveMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the audit is not in `failed` state', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: makeFailedAudit({ status: 'completed' }),
      error: null,
    });
    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(409);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('CAS uses the current retry_count as the predicate and writes count+1', async () => {
    // Simulate an audit that's been retried twice already (retry_count=2).
    auditsSelectMock.mockResolvedValueOnce({
      data: makeFailedAudit({ retry_count: 2 }),
      error: null,
    });
    adminUpdateSelectMock.mockResolvedValueOnce({
      data: [{ retry_count: 3 }],
      error: null,
    });
    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(200);

    // Idempotency key tracks the new count.
    const sent = inngestSendMock.mock.calls[0]?.[0] as {
      id?: string;
      data?: { retryCount?: unknown };
    };
    expect(sent?.id).toBe(`${TEST_AUDIT_ID}-uploaded-retry-3`);
    expect(sent?.data?.retryCount).toBe(3);
  });

  it('re-consumes credit after CAS reset when credit_consumed=false', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: makeFailedAudit({ credit_consumed: false }),
      error: null,
    });
    assertCanRunAuditMock.mockResolvedValueOnce({
      ok: true,
      reason: 'credit',
      remaining: 1,
    });

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());

    expect(res.status).toBe(200);
    expect(adminUpdateRows[0]?.['status']).toBe('pending');
    expect(consumeAuditCreditMock).toHaveBeenCalledWith(TEST_USER_ID, TEST_AUDIT_ID);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it('consumes credit only after the row is reset to pending', async () => {
    const callOrder: string[] = [];
    adminUpdateSelectMock.mockImplementation(async () => {
      callOrder.push('cas-update');
      return { data: [{ retry_count: 1 }], error: null };
    });
    consumeAuditCreditMock.mockImplementation(async () => {
      callOrder.push('consume');
      return { remaining: 0, idempotent: false };
    });
    auditsSelectMock.mockResolvedValueOnce({
      data: makeFailedAudit({ credit_consumed: false }),
      error: null,
    });
    assertCanRunAuditMock.mockResolvedValueOnce({
      ok: true,
      reason: 'credit',
      remaining: 1,
    });

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    await POST(req, makeContext());

    expect(callOrder).toEqual(['cas-update', 'consume']);
  });

  it('skips credit consume when credit_consumed=true (user-fault failure)', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: makeFailedAudit({ credit_consumed: true }),
      error: null,
    });

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());

    expect(res.status).toBe(200);
    expect(assertCanRunAuditMock).not.toHaveBeenCalled();
    expect(consumeAuditCreditMock).not.toHaveBeenCalled();
  });

  it('returns 402 when credit_consumed=false and user has no credits', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: makeFailedAudit({ credit_consumed: false }),
      error: null,
    });
    assertCanRunAuditMock.mockResolvedValueOnce({
      ok: true,
      reason: 'credit',
      remaining: 1,
    });
    consumeAuditCreditMock.mockRejectedValueOnce(new Error('no_credits'));

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(402);
    expect(body.error).toBe('no_plan');
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(adminUpdateRows.some((row) => row['status'] === 'failed')).toBe(true);
  });

  it('returns 503 and rolls back when credit consume fails transiently', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: makeFailedAudit({ credit_consumed: false }),
      error: null,
    });
    assertCanRunAuditMock.mockResolvedValueOnce({
      ok: true,
      reason: 'credit',
      remaining: 1,
    });
    consumeAuditCreditMock.mockRejectedValueOnce(new Error('connection reset'));

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(503);
    expect(body.error).toBe('credit_decrement_unavailable');
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('subscription user with credit_consumed=false does not call consume', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: makeFailedAudit({ credit_consumed: false }),
      error: null,
    });
    assertCanRunAuditMock.mockResolvedValueOnce({ ok: true, reason: 'subscription' });

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());

    expect(res.status).toBe(200);
    expect(assertCanRunAuditMock).toHaveBeenCalledTimes(1);
    expect(consumeAuditCreditMock).not.toHaveBeenCalled();
  });

  it('refunds re-consumed credit when enqueue fails after a refunded retry', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: makeFailedAudit({ credit_consumed: false }),
      error: null,
    });
    assertCanRunAuditMock.mockResolvedValueOnce({
      ok: true,
      reason: 'credit',
      remaining: 1,
    });
    inngestSendMock.mockRejectedValueOnce(new Error('inngest unavailable'));

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());

    expect(res.status).toBe(500);
    expect(refundFailedAuditMock).toHaveBeenCalledWith('refund_failed_audit', {
      p_audit_id: TEST_AUDIT_ID,
      p_user_id: TEST_USER_ID,
    });
  });

  it('inngest.send failure rolls status back guarded by pending and keeps incremented retry_count', async () => {
    inngestSendMock.mockRejectedValueOnce(new Error('accepted-but-timeout'));

    const req = new Request('http://localhost/api/audits/X/retry', { method: 'POST' });
    const res = await POST(req, makeContext());

    expect(res.status).toBe(500);
    expect(adminUpdateRows.at(-1)).toMatchObject({
      status: 'failed',
      retry_count: 1,
    });
    expect(adminUpdateFilters.at(-1)).toEqual(
      expect.arrayContaining([
        ['id', TEST_AUDIT_ID],
        ['status', 'pending'],
        ['retry_count', 1],
      ]),
    );
  });
});
