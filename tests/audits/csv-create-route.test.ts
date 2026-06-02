import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/audits/csv — CSV upload-init route.
 *
 * Differences from the PDF init route this is parallel to:
 *   - tighter MAX_BYTES (5 MB)
 *   - stricter extension allowlist (`.csv` only)
 *   - credit is NOT consumed here (the process route does it after parse)
 *   - source_format='csv' marker so downstream code can distinguish ingests
 *
 * Coverage:
 *   - 400 malformed JSON / wrong shape / non-csv filename
 *   - 401 missing session
 *   - 402 past_due vs no_plan distinct error codes (gate.ok=false branches)
 *   - 429 rate-limit exhausted
 *   - 500 on insert error
 *   - 500 + rollback on signed-upload-URL error
 *   - 200 happy path returns { auditId, uploadUrl, storagePath, token }
 *   - Storage path is owner-scoped (`<userId>/<auditId>/<safeName>`)
 *   - Filename sanitization strips path traversal + dangerous chars
 */

const USER_ID = '33333333-3333-4333-8333-333333333333';

const { getUserMock, consumeRateLimitMock, gateMock, insertMock, deleteMock, signedUploadMock } =
  vi.hoisted(() => ({
    getUserMock: vi.fn(),
    consumeRateLimitMock: vi.fn(),
    gateMock: vi.fn(),
    insertMock: vi.fn(),
    deleteMock: vi.fn(),
    signedUploadMock: vi.fn(),
  }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => insertMock(row),
      delete: () => ({
        eq: async () => deleteMock(),
      }),
    }),
    storage: {
      from: () => ({
        createSignedUploadUrl: (path: string, opts: unknown) => signedUploadMock(path, opts),
      }),
    },
  }),
}));

vi.mock('@/lib/access/gate', () => ({
  assertCanRunAudit: gateMock,
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

import { POST } from '@/app/api/audits/csv/route';

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/audits/csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === '__raw_malformed__' ? '{not json' : JSON.stringify(body),
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  consumeRateLimitMock.mockReset();
  gateMock.mockReset();
  insertMock.mockReset();
  deleteMock.mockReset();
  signedUploadMock.mockReset();

  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID } },
    error: null,
  });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    resetAt: new Date().toISOString(),
  });
  gateMock.mockResolvedValue({ ok: true });
  insertMock.mockResolvedValue({ error: null });
  signedUploadMock.mockResolvedValue({
    data: { signedUrl: 'https://upload.example/path?sig=abc', token: 'tok' },
    error: null,
  });
});

describe('POST /api/audits/csv — body validation', () => {
  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeReq('__raw_malformed__'));
    expect(res.status).toBe(400);
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it('returns 400 when filename is missing', async () => {
    const res = await POST(makeReq({ size_bytes: 1000 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when size_bytes is missing', async () => {
    const res = await POST(makeReq({ filename: 'bill.csv' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when size_bytes exceeds 5 MB cap', async () => {
    const res = await POST(makeReq({ filename: 'bill.csv', size_bytes: 6 * 1024 * 1024 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain('5 mb');
  });

  it('rejects non-.csv filenames (e.g. .pdf)', async () => {
    const res = await POST(makeReq({ filename: 'bill.pdf', size_bytes: 1000 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain('.csv');
  });

  it('accepts uppercase .CSV extension (case-insensitive)', async () => {
    const res = await POST(makeReq({ filename: 'bill.CSV', size_bytes: 1000 }));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/audits/csv — auth + plan gate', () => {
  it('returns 401 when no session', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    expect(res.status).toBe(401);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns 402 subscription_past_due on gate past_due', async () => {
    gateMock.mockResolvedValueOnce({ ok: false, reason: 'past_due' });
    const res = await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('subscription_past_due');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns 402 no_plan on gate no_plan (default rejection)', async () => {
    gateMock.mockResolvedValueOnce({ ok: false, reason: 'no_credits' });
    const res = await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; upgrade_url: string };
    expect(body.error).toBe('no_plan');
    expect(body.upgrade_url).toBe('/pricing');
  });

  it('returns 429 when per-user rate limit is exhausted', async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      resetAt: new Date().toISOString(),
    });
    const res = await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    expect(res.status).toBe(429);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rate-limit key is per-userId and uses the "audit-create-csv" namespace', async () => {
    await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as { key: string };
    expect(call.key).toBe(`audit-create-csv:${USER_ID}`);
  });
});

describe('POST /api/audits/csv — happy path', () => {
  it('inserts the audit row with credit_consumed=false and source_format="csv"', async () => {
    await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    const row = insertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.status).toBe('pending');
    expect(row.credit_consumed).toBe(false);
    expect(row.source_format).toBe('csv');
    expect(row.user_id).toBe(USER_ID);
    expect(typeof row.id).toBe('string');
  });

  it('returns 200 with auditId, uploadUrl, storagePath, and token', async () => {
    const res = await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(typeof body.auditId).toBe('string');
    expect(body.uploadUrl).toBe('https://upload.example/path?sig=abc');
    expect(body.token).toBe('tok');
    expect(body.storagePath).toContain(USER_ID);
    expect(body.storagePath).toContain(body.auditId);
  });

  it('owner-scopes the storage path so a user cannot write under another user prefix', async () => {
    await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    const row = insertMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(row.storage_path?.startsWith(`${USER_ID}/`)).toBe(true);
  });
});

describe('POST /api/audits/csv — filename sanitization', () => {
  it('strips path traversal segments before composing the storage path', async () => {
    await POST(makeReq({ filename: '../../../etc/passwd.csv', size_bytes: 100 }));
    const row = insertMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(row.storage_path).not.toContain('..');
    expect(row.storage_path).not.toContain('/etc/');
    // The basename is preserved (just the safe portion).
    expect(row.storage_path).toMatch(/\/passwd\.csv$/);
  });

  it('replaces shell-unsafe characters with underscores', async () => {
    await POST(makeReq({ filename: 'bi ll;rm -rf.csv', size_bytes: 100 }));
    const row = insertMock.mock.calls[0]?.[0] as Record<string, string>;
    // The original filename column keeps the raw name (for display).
    expect(row.original_filename).toBe('bi ll;rm -rf.csv');
    // But the storage path uses the sanitized form (no spaces/semicolons).
    expect(row.storage_path).not.toContain(' ');
    expect(row.storage_path).not.toContain(';');
  });
});

describe('POST /api/audits/csv — error paths', () => {
  it('returns 500 when the insert fails (no rollback needed)', async () => {
    insertMock.mockResolvedValueOnce({ error: { message: 'db error' } });
    const res = await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    expect(res.status).toBe(500);
    expect(signedUploadMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('rolls back the audit row when createSignedUploadUrl fails', async () => {
    signedUploadMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'sign error' },
    });
    const res = await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    expect(res.status).toBe(500);
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('uses 15-minute TTL for the signed upload URL', async () => {
    await POST(makeReq({ filename: 'bill.csv', size_bytes: 1000 }));
    const opts = signedUploadMock.mock.calls[0]?.[1] as { expiresIn: number };
    expect(opts.expiresIn).toBe(60 * 15);
  });
});
