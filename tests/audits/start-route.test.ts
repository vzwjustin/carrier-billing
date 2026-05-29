import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/audits/[id]/start — the route that transitions an
 * audit from `pending` (file in storage) to the Inngest worker.
 *
 * These cover B2 (idempotency key on `bill.uploaded` send): a duplicate /start
 * POST or a browser/proxy retry must not enqueue the worker twice. We assert
 * the `id` field is present and is anchored to the audit id so Inngest's
 * de-dupe (window: ~24h) collapses retries onto a single run.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────
type GetUserResult = {
  data: { user: { id: string } | null };
  error: null;
};
type AuditRowResp = {
  data: {
    id: string;
    user_id: string;
    status: string;
    storage_path: string;
    retry_count: number;
  } | null;
  error: null | { message: string };
};

// Wrap top-level mocks in vi.hoisted so they're initialized before the
// vi.mock factories below run (per CLAUDE.md test-mocking rule).
const {
  getUserMock,
  auditsSelectMock,
  inngestSendMock,
  sentryCaptureMock,
  consumeRateLimitMock,
  assertCanStartPendingAuditMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn<() => Promise<GetUserResult>>(),
  auditsSelectMock: vi.fn<() => Promise<AuditRowResp>>(),
  inngestSendMock: vi.fn(async (_event: unknown) => undefined),
  sentryCaptureMock: vi.fn(),
  consumeRateLimitMock: vi.fn<
    (config: { key: string; limit: number; windowSeconds: number }) => Promise<
      | { ok: true; remaining: number; resetAt: string }
      | { ok: false; remaining: number; resetAt: string }
    >
  >(),
  assertCanStartPendingAuditMock: vi.fn<
    () => Promise<{ ok: true } | { ok: false; reason: 'past_due' }>
  >(),
}));

vi.mock('@/lib/access/gate', () => ({
  assertCanStartPendingAudit: () => assertCanStartPendingAuditMock(),
}));

// `from('audits').select(...).eq(...).maybeSingle()` chain
function makeFromChain() {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: () => auditsSelectMock(),
      }),
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
    from: (_table: string) => makeFromChain(),
  }),
}));

vi.mock('@/inngest/client', () => ({
  inngest: { send: (event: unknown) => inngestSendMock(event) },
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

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: (config: {
    key: string;
    limit: number;
    windowSeconds: number;
  }) => consumeRateLimitMock(config),
  rateLimitedResponse: (resetAt: string) =>
    new Response(JSON.stringify({ error: 'rate_limited', resetAt }), {
      status: 429,
    }),
}));

// Import after mocks register.
import { POST } from '@/app/api/audits/[id]/start/route';

const TEST_AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

function makeContext() {
  return { params: Promise.resolve({ id: TEST_AUDIT_ID }) };
}

beforeEach(() => {
  getUserMock.mockReset();
  auditsSelectMock.mockReset();
  inngestSendMock.mockReset();
  sentryCaptureMock.mockReset();
  consumeRateLimitMock.mockReset();
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    remaining: 9,
    resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  assertCanStartPendingAuditMock.mockReset();
  assertCanStartPendingAuditMock.mockResolvedValue({ ok: true });

  getUserMock.mockResolvedValue({
    data: { user: { id: TEST_USER_ID } },
    error: null,
  });
  auditsSelectMock.mockResolvedValue({
    data: {
      id: TEST_AUDIT_ID,
      user_id: TEST_USER_ID,
      status: 'pending',
      storage_path: `${TEST_USER_ID}/audit/bill.pdf`,
      retry_count: 0,
    },
    error: null,
  });
});

describe('POST /api/audits/[id]/start', () => {
  it('happy path: returns 200 and sends bill.uploaded with idempotency id', async () => {
    const req = new Request('http://localhost/api/audits/X/start', {
      method: 'POST',
    });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(200);

    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    const sent = inngestSendMock.mock.calls[0]?.[0] as
      | undefined
      | {
          id?: string;
          name?: string;
          data?: Record<string, unknown>;
        };
    expect(sent).toBeDefined();
    expect(sent?.name).toBe('bill.uploaded');
    // (B2) Idempotency key — must be present and anchored to the audit id.
    expect(sent?.id).toBe(`${TEST_AUDIT_ID}-uploaded`);
    expect(sent?.data?.auditId).toBe(TEST_AUDIT_ID);
    expect(sent?.data?.userId).toBe(TEST_USER_ID);
    expect(sent?.data?.storagePath).toBe(`${TEST_USER_ID}/audit/bill.pdf`);
    expect(sent?.data?.retryCount).toBe(0);
  });

  it('uses retry-scoped idempotency id when retry_count > 0', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: {
        id: TEST_AUDIT_ID,
        user_id: TEST_USER_ID,
        status: 'pending',
        storage_path: `${TEST_USER_ID}/audit/bill.pdf`,
        retry_count: 2,
      },
      error: null,
    });

    const req = new Request('http://localhost/api/audits/X/start', {
      method: 'POST',
    });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(200);

    const sent = inngestSendMock.mock.calls[0]?.[0] as { id?: string };
    expect(sent?.id).toBe(`${TEST_AUDIT_ID}-uploaded-retry-2`);
  });

  it('returns 429 when the per-user start rate limit is exceeded', async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      remaining: 0,
      resetAt: '2026-05-30T12:00:00.000Z',
    });

    const req = new Request('http://localhost/api/audits/X/start', {
      method: 'POST',
    });
    const res = await POST(req, makeContext());

    expect(res.status).toBe(429);
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(consumeRateLimitMock).toHaveBeenCalledWith({
      key: `audit-start:${TEST_USER_ID}`,
      limit: 10,
      windowSeconds: 60 * 60,
    });
  });

  it('duplicate POST sends two events with the SAME idempotency id (Inngest dedupes)', async () => {
    // Two browser/proxy retries hitting /start before the row is moved off
    // `pending`. Both should enqueue events; both events should carry the
    // identical `id` so Inngest's server-side dedupe collapses them to one
    // worker run.
    const req = new Request('http://localhost/api/audits/X/start', {
      method: 'POST',
    });
    const r1 = await POST(req, makeContext());
    const r2 = await POST(req, makeContext());

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(inngestSendMock).toHaveBeenCalledTimes(2);
    const a = inngestSendMock.mock.calls[0]?.[0] as { id?: string };
    const b = inngestSendMock.mock.calls[1]?.[0] as { id?: string };
    expect(a?.id).toBeDefined();
    expect(a?.id).toBe(b?.id);
  });

  it('returns 401 when there is no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const req = new Request('http://localhost/api/audits/X/start', {
      method: 'POST',
    });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(401);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 402 when subscription is past_due (start gate)', async () => {
    assertCanStartPendingAuditMock.mockResolvedValueOnce({
      ok: false,
      reason: 'past_due',
    });
    const req = new Request('http://localhost/api/audits/X/start', {
      method: 'POST',
    });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(402);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('subscription_past_due');
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the audit is not pending — no event sent', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: {
        id: TEST_AUDIT_ID,
        user_id: TEST_USER_ID,
        status: 'extracting',
        storage_path: `${TEST_USER_ID}/audit/bill.pdf`,
        retry_count: 0,
      },
      error: null,
    });
    const req = new Request('http://localhost/api/audits/X/start', {
      method: 'POST',
    });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(409);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the audit is owned by another user', async () => {
    auditsSelectMock.mockResolvedValueOnce({
      data: {
        id: TEST_AUDIT_ID,
        user_id: 'someone-else',
        status: 'pending',
        storage_path: `${TEST_USER_ID}/audit/bill.pdf`,
        retry_count: 0,
      },
      error: null,
    });
    const req = new Request('http://localhost/api/audits/X/start', {
      method: 'POST',
    });
    const res = await POST(req, makeContext());
    expect(res.status).toBe(404);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('scrubs enqueue errors before logging them', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    inngestSendMock.mockRejectedValueOnce(
      new Error('enqueue failed for user@example.com acct 1234567890123'),
    );

    try {
      const req = new Request('http://localhost/api/audits/X/start', {
        method: 'POST',
      });
      const res = await POST(req, makeContext());

      expect(res.status).toBe(502);
      const logged = consoleErrorSpy.mock.calls.flat().join(' ');
      expect(logged).not.toContain('user@example.com');
      expect(logged).not.toContain('1234567890123');
      expect(logged).toContain('[email]');
      const [err, ctx] = sentryCaptureMock.mock.calls[0] as [
        Error,
        { tags?: { surface?: string }; extra?: { auditId?: string } },
      ];
      expect(err.message).toContain('[email]');
      expect(err.message).not.toContain('user@example.com');
      expect(ctx.tags?.surface).toBe('audits.start.inngest_send');
      expect(ctx.extra?.auditId).toBe(TEST_AUDIT_ID);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('reports unexpected route errors with a scrubbed message', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    getUserMock.mockRejectedValueOnce(
      new Error('auth failed for user@example.com acct 1234567890123'),
    );

    try {
      const req = new Request('http://localhost/api/audits/X/start', {
        method: 'POST',
      });
      const res = await POST(req, makeContext());

      expect(res.status).toBe(500);
      const [err, ctx] = sentryCaptureMock.mock.calls[0] as [
        Error,
        { tags?: { surface?: string }; extra?: { auditId?: string } },
      ];
      expect(err.message).toContain('[email]');
      expect(err.message).not.toContain('user@example.com');
      expect(err.message).not.toContain('1234567890123');
      expect(ctx.tags?.surface).toBe('audits.start');
      expect(ctx.extra?.auditId).toBe(TEST_AUDIT_ID);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
