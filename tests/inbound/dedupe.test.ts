import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// ─── Mocks (must be set up before importing the route) ─────────────────────

type MutationResult = { data: null; error: { message: string } | null };

const inboundEventsInsertMock =
  vi.fn<
    (row: unknown) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>
  >();
const inboundEventsUpdateEqMock = vi.fn(async () => ({ data: null, error: null }));
const inboundEventsDeleteEqMock = vi.fn<() => Promise<MutationResult>>(async () => ({
  data: null,
  error: null,
}));
const profilesSelectMock = vi.fn();
const auditsInsertMock = vi.fn(async (_row: unknown) => ({ data: null, error: null }));
const auditsDeleteEqMock = vi.fn<() => Promise<MutationResult>>(async () => ({
  data: null,
  error: null,
}));
const auditsUpdateEqMock = vi.fn<() => Promise<MutationResult>>(async () => ({
  data: null,
  error: null,
}));
const storageUploadMock = vi.fn<
  (
    path: string,
    body: Buffer,
    opts: unknown,
  ) => Promise<{ data: unknown; error: { message: string } | null }>
>(async (_path: string, _body: Buffer, _opts: unknown) => ({
  data: null,
  error: null,
}));
const storageRemoveMock = vi.fn<(_paths: string[]) => Promise<MutationResult>>(async () => ({
  data: null,
  error: null,
}));
const inngestSendMock = vi.fn(async (..._args: unknown[]) => ({}));
const decrementMock = vi.fn(async (_uid: string, _auditId: string) => ({
  remaining: 0,
  idempotent: false,
}));
const rpcMock = vi.fn(async (_fn: string, _args: unknown) => ({ data: null, error: null }));
const gateMock = vi.fn<
  (
    uid: string,
  ) => Promise<{ ok: true; reason: 'subscription' | 'credit' } | { ok: false; reason: string }>
>(async () => ({ ok: true, reason: 'subscription' }));
const consumeRateLimitMock = vi.fn(async (_opts: unknown) => ({ ok: true, resetAt: new Date() }));

const fromMock = vi.fn((table: string) => {
  if (table === 'profiles') {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => profilesSelectMock(),
        }),
      }),
    };
  }
  if (table === 'inbound_email_events') {
    return {
      insert: (row: unknown) => inboundEventsInsertMock(row),
      update: () => ({
        eq: () => inboundEventsUpdateEqMock(),
      }),
      delete: () => ({
        eq: () => inboundEventsDeleteEqMock(),
      }),
    };
  }
  if (table === 'audits') {
    return {
      insert: (row: unknown) => auditsInsertMock(row),
      update: (_row: unknown) => ({
        eq: () => auditsUpdateEqMock(),
      }),
      delete: () => ({
        eq: () => auditsDeleteEqMock(),
      }),
    };
  }
  return {};
});

const storageFromMock = vi.fn((_bucket: string) => ({
  upload: (path: string, body: Buffer, opts: unknown) => storageUploadMock(path, body, opts),
  remove: (paths: string[]) => storageRemoveMock(paths),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: fromMock,
    rpc: (fn: string, args: unknown) => rpcMock(fn, args),
    storage: { from: storageFromMock },
  }),
}));

vi.mock('@/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => inngestSendMock(...args) },
}));

vi.mock('@/lib/access/gate', () => ({
  assertCanRunAudit: (uid: string) => gateMock(uid),
}));

vi.mock('@/lib/access/decrement', () => ({
  consumeAuditCreditForAudit: (uid: string, auditId: string) => decrementMock(uid, auditId),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: (opts: unknown) => consumeRateLimitMock(opts),
}));

vi.mock('@/env', () => ({
  env: {
    INBOUND_EMAIL_SECRET: 'test-secret-1234567890abcdef',
    INBOUND_EMAIL_DOMAIN: 'inbound.example.com',
  },
}));

const { captureExceptionMock, captureMessageMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  captureMessageMock: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: captureMessageMock,
  captureException: captureExceptionMock,
}));

// Import after mocks. The real `@/lib/inbound/token` is intentionally not
// mocked — we want its real `parseInboundRecipient` + `verifyHmac` here.
import { POST } from '@/app/api/inbound/email/route';


const SECRET = 'test-secret-1234567890abcdef';
const TOKEN = 'abcdefgh23456pqr'; // 16-char base32 (RFC4648: a-z, 2-7)

interface InboundPayload {
  to: string;
  from?: string;
  subject?: string;
  attachments: Array<{
    filename: string;
    content_type: string;
    content_base64: string;
  }>;
}

function makeRequest(payload: InboundPayload, raw?: string): Request {
  const body = raw ?? JSON.stringify(payload);
  const sig = createHmac('sha256', SECRET).update(body).digest('hex');
  return new Request('http://localhost/api/inbound/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      'X-Inbound-Signature': sig,
    },
    body,
  });
}

beforeEach(() => {
  inboundEventsInsertMock.mockReset();
  inboundEventsInsertMock.mockResolvedValue({ data: null, error: null });
  inboundEventsUpdateEqMock.mockClear();
  inboundEventsDeleteEqMock.mockClear();
  profilesSelectMock.mockReset();
  profilesSelectMock.mockResolvedValue({
    data: { id: 'user-uuid-1' },
    error: null,
  });
  auditsInsertMock.mockClear();
  auditsDeleteEqMock.mockClear();
  auditsUpdateEqMock.mockClear();
  rpcMock.mockClear();
  storageUploadMock.mockClear();
  storageRemoveMock.mockClear();
  inngestSendMock.mockClear();
  decrementMock.mockClear();
  rpcMock.mockClear();
  rpcMock.mockResolvedValue({ data: null, error: null });
  gateMock.mockClear();
  gateMock.mockResolvedValue({ ok: true, reason: 'subscription' });
  consumeRateLimitMock.mockClear();
  consumeRateLimitMock.mockResolvedValue({ ok: true, resetAt: new Date() });
  captureExceptionMock.mockClear();
  captureMessageMock.mockClear();
});

describe('POST /api/inbound/email — dedupe stability', () => {
  it('rejects payload over content-length cap before reading body', async () => {
    const body = JSON.stringify({ junk: 'x' });
    const req = new Request('http://localhost/api/inbound/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 50 MB > 40 MB cap.
        'Content-Length': String(50 * 1024 * 1024),
        'X-Inbound-Signature': 'irrelevant',
      },
      body,
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it('returns 411 when Content-Length missing', async () => {
    // Use a hand-rolled headers object so we control exactly what's sent;
    // some Request impls auto-add Content-Length when given a string body.
    const headers = new Headers({
      'Content-Type': 'application/json',
      'X-Inbound-Signature': 'irrelevant',
    });
    headers.delete('content-length');
    const req = new Request('http://localhost/api/inbound/email', {
      method: 'POST',
      headers,
      body: JSON.stringify({ junk: 'x' }),
    });
    // If the runtime auto-added it back, the test environment can't validate
    // this branch — skip silently rather than fail on a platform quirk.
    if (req.headers.get('content-length')) return;
    const res = await POST(req);
    expect(res.status).toBe(411);
  });

  it('content-stable hash: flipping whitespace in the email body does NOT bypass dedupe', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 hello world bytes', 'utf8');
    const pdfB64 = pdfBytes.toString('base64');

    const payloadA: InboundPayload = {
      to: `bills+${TOKEN}@inbound.example.com`,
      from: 'user@carrier.com',
      subject: 'Your bill',
      attachments: [
        {
          filename: 'bill.pdf',
          content_type: 'application/pdf',
          content_base64: pdfB64,
        },
      ],
    };

    // First request — succeeds, dedupe row created.
    let res = await POST(makeRequest(payloadA));
    expect(res.status).toBe(200);
    const body1 = (await res.json()) as { ok: boolean; auditId?: string };
    expect(body1.ok).toBe(true);
    expect(body1.auditId).toBeTruthy();
    expect(inboundEventsInsertMock).toHaveBeenCalledTimes(1);
    const firstHash = (inboundEventsInsertMock.mock.calls[0]?.[0] as { event_hash: string })
      .event_hash;
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/);

    // Second request — same userId + same PDF + same filename, but the email
    // body has extra whitespace inserted. With the OLD raw-body hash this
    // would compute a different `event_hash` and bypass dedupe. With the new
    // content-key hash, the PG unique-violation should fire and we should
    // short-circuit to `{ deduped: true }`.
    inboundEventsInsertMock.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });

    // Build the body manually with extra whitespace, then sign it.
    const rawA = JSON.stringify(payloadA);
    const rawWithWhitespace = rawA.replace('"to":', '"to":  ');
    expect(rawWithWhitespace).not.toBe(rawA);

    res = await POST(makeRequest(payloadA, rawWithWhitespace));
    expect(res.status).toBe(200);
    const body2 = (await res.json()) as { ok: boolean; deduped?: boolean };
    expect(body2.ok).toBe(true);
    expect(body2.deduped).toBe(true);

    // The second insert was attempted with the SAME hash as the first.
    expect(inboundEventsInsertMock).toHaveBeenCalledTimes(2);
    const secondHash = (inboundEventsInsertMock.mock.calls[1]?.[0] as { event_hash: string })
      .event_hash;
    expect(secondHash).toBe(firstHash);

    // And no second storage upload happened — dedupe fired before upload.
    expect(storageUploadMock).toHaveBeenCalledTimes(1);
  });

  it('inserts the dedupe row BEFORE attempting storage upload', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 trace', 'utf8');
    const payload: InboundPayload = {
      to: `bills+${TOKEN}@inbound.example.com`,
      attachments: [
        {
          filename: 'bill.pdf',
          content_type: 'application/pdf',
          content_base64: pdfBytes.toString('base64'),
        },
      ],
    };
    const order: string[] = [];
    inboundEventsInsertMock.mockImplementationOnce(async () => {
      order.push('dedupe-insert');
      return { data: null, error: null };
    });
    storageUploadMock.mockImplementationOnce(async () => {
      order.push('storage-upload');
      return { data: null, error: null };
    });
    const res = await POST(makeRequest(payload));
    expect(res.status).toBe(200);
    expect(order).toEqual(['dedupe-insert', 'storage-upload']);
  });

  it('skips recipients outside the configured inbound domain', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 domain', 'utf8');
    const payload: InboundPayload = {
      to: `bills+${TOKEN}@other.example.com`,
      attachments: [
        {
          filename: 'bill.pdf',
          content_type: 'application/pdf',
          content_base64: pdfBytes.toString('base64'),
        },
      ],
    };

    const res = await POST(makeRequest(payload));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toBe('bad_recipient_domain');
    expect(profilesSelectMock).not.toHaveBeenCalled();
    expect(inboundEventsInsertMock).not.toHaveBeenCalled();
  });

  it('skips malformed base64 attachments before creating audit state', async () => {
    const payload: InboundPayload = {
      to: `bills+${TOKEN}@inbound.example.com`,
      attachments: [
        {
          filename: 'bill.pdf',
          content_type: 'application/pdf',
          content_base64: '%%%not-base64%%%',
        },
      ],
    };

    const res = await POST(makeRequest(payload));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toBe('invalid_attachment');
    expect(gateMock).not.toHaveBeenCalled();
    expect(auditsInsertMock).not.toHaveBeenCalled();
    expect(inboundEventsInsertMock).not.toHaveBeenCalled();
    expect(storageUploadMock).not.toHaveBeenCalled();
  });

  it('skips attachments that claim to be PDF but do not have PDF magic bytes', async () => {
    const payload: InboundPayload = {
      to: `bills+${TOKEN}@inbound.example.com`,
      attachments: [
        {
          filename: 'bill.pdf',
          content_type: 'application/pdf',
          content_base64: Buffer.from('not a pdf', 'utf8').toString('base64'),
        },
      ],
    };

    const res = await POST(makeRequest(payload));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toBe('non_pdf_attachment');
    expect(gateMock).not.toHaveBeenCalled();
    expect(auditsInsertMock).not.toHaveBeenCalled();
    expect(inboundEventsInsertMock).not.toHaveBeenCalled();
    expect(storageUploadMock).not.toHaveBeenCalled();
  });

  it('returns provider-ack 200 when inbound rate limit denies', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 rate-limit', 'utf8');
    const payload: InboundPayload = {
      to: `bills+${TOKEN}@inbound.example.com`,
      attachments: [
        {
          filename: 'bill.pdf',
          content_type: 'application/pdf',
          content_base64: pdfBytes.toString('base64'),
        },
      ],
    };
    consumeRateLimitMock.mockResolvedValueOnce({ ok: false, resetAt: new Date() });

    const res = await POST(makeRequest(payload));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, skipped: 'rate_limited' });
    expect(inboundEventsInsertMock).not.toHaveBeenCalled();
  });

  it('releases dedupe claim when downstream storage upload fails', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 storage-fail', 'utf8');
    const payload: InboundPayload = {
      to: `bills+${TOKEN}@inbound.example.com`,
      attachments: [
        {
          filename: 'bill.pdf',
          content_type: 'application/pdf',
          content_base64: pdfBytes.toString('base64'),
        },
      ],
    };
    storageUploadMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'storage offline' },
    });

    const res = await POST(makeRequest(payload));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toBe('internal_error');
    expect(inboundEventsDeleteEqMock).toHaveBeenCalledTimes(1);
  });

  it('reports returned audit-delete errors while cleaning up failed storage uploads', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 storage-fail-delete-error', 'utf8');
    const payload: InboundPayload = {
      to: `bills+${TOKEN}@inbound.example.com`,
      attachments: [
        {
          filename: 'bill.pdf',
          content_type: 'application/pdf',
          content_base64: pdfBytes.toString('base64'),
        },
      ],
    };
    storageUploadMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'storage offline' },
    });
    auditsDeleteEqMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'delete failed' },
    });

    const res = await POST(makeRequest(payload));

    expect(res.status).toBe(200);
    const cleanupCall = captureExceptionMock.mock.calls.find(
      ([_err, ctx]) =>
        (ctx as { tags?: Record<string, unknown> } | undefined)?.tags?.['surface'] ===
        'inbound.email.rollback_storage_upload_failed',
    );
    expect(cleanupCall).toBeTruthy();
    expect((cleanupCall?.[0] as Error).message).toBe('delete failed');
  });

  it('refunds/fails and releases the dedupe claim when credit decrement is transient', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 decrement-transient', 'utf8');
    const payload: InboundPayload = {
      to: `bills+${TOKEN}@inbound.example.com`,
      attachments: [
        {
          filename: 'bill.pdf',
          content_type: 'application/pdf',
          content_base64: pdfBytes.toString('base64'),
        },
      ],
    };
    gateMock.mockResolvedValueOnce({ ok: true, reason: 'credit' });
    decrementMock.mockRejectedValueOnce(new Error('network reset'));

    const res = await POST(makeRequest(payload));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toBe('decrement_transient');
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith('refund_orphan_audit', {
      p_audit_id: expect.any(String),
      p_user_id: 'user-uuid-1',
      p_reason: 'inbound-credit-decrement-failed',
    });
    expect(storageRemoveMock).toHaveBeenCalledTimes(1);
    expect(inboundEventsDeleteEqMock).toHaveBeenCalledTimes(1);
  });

  it('refunds via refund_orphan_audit BEFORE deleting the row when bill.uploaded dispatch fails', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 dispatch-fail', 'utf8');
    const payload: InboundPayload = {
      to: `bills+${TOKEN}@inbound.example.com`,
      attachments: [
        {
          filename: 'bill.pdf',
          content_type: 'application/pdf',
          content_base64: pdfBytes.toString('base64'),
        },
      ],
    };
    gateMock.mockResolvedValueOnce({ ok: true, reason: 'credit' });
    inngestSendMock.mockRejectedValueOnce(new Error('inngest down'));

    const res = await POST(makeRequest(payload));

    // The rethrown sendErr is swallowed by the outer catch → 200 so the email
    // provider doesn't retry; orphan-cleanup would catch any half-created row.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toBe('internal_error');
    // Refund via the idempotent, row-anchored RPC (not a bare increment), so a
    // retry / the orphan-cleanup cron can't double-refund.
    expect(rpcMock).toHaveBeenCalledWith('refund_orphan_audit', {
      p_audit_id: expect.any(String),
      p_user_id: 'user-uuid-1',
      p_reason: 'inbound-dispatch-failed',
    });
    // Refund must run BEFORE the audit-row delete (the RPC has to match the
    // still-present pending row) — this is the crash-window leak fix.
    const refundIdx = rpcMock.mock.calls.findIndex(([fn]) => fn === 'refund_orphan_audit');
    expect(refundIdx).toBeGreaterThanOrEqual(0);
    expect(rpcMock.mock.invocationCallOrder[refundIdx]!).toBeLessThan(
      auditsDeleteEqMock.mock.invocationCallOrder[0]!,
    );
    expect(inboundEventsDeleteEqMock).toHaveBeenCalledTimes(1);
  });
});
