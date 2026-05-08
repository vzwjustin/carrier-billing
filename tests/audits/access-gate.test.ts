import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks --------------------------------------------------------------
// Declared before importing the route under test.

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};
type InsertResult = { data: unknown; error: null | { message: string } };
type SignedUrlResult = {
  data: { signedUrl: string; token: string; path: string } | null;
  error: null | { message: string };
};

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const auditsInsertMock = vi.fn<(row: unknown) => Promise<InsertResult>>();
const auditsDeleteEqMock = vi.fn(async () => ({ data: null, error: null }));
const createSignedUploadUrlMock =
  vi.fn<(path: string) => Promise<SignedUrlResult>>();

const fromMock = vi.fn((_table: string) => ({
  insert: (row: unknown) => auditsInsertMock(row),
  delete: () => ({
    eq: () => auditsDeleteEqMock(),
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
    from: fromMock,
    storage: {
      from: storageFromMock,
    },
  }),
}));

// We mock the gate + decrement helpers directly. Their own behavior is
// covered by gate.test.ts and decrement.test.ts; here we only care that the
// route wires them together correctly.
import type { AccessGateResult } from '@/lib/access/gate';

const assertCanRunAuditMock = vi.fn<() => Promise<AccessGateResult>>();
const decrementMock = vi.fn<() => Promise<{ remaining: number }>>();

vi.mock('@/lib/access/gate', () => ({
  assertCanRunAudit: () => assertCanRunAuditMock(),
}));

vi.mock('@/lib/access/decrement', () => ({
  decrementAuditCreditAtomically: () => decrementMock(),
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
  assertCanRunAuditMock.mockReset();
  decrementMock.mockReset();

  getUserMock.mockResolvedValue({
    data: { user: { id: 'user-1', email: 'a@b.com' } },
    error: null,
  });
  auditsInsertMock.mockResolvedValue({ data: null, error: null });
  createSignedUploadUrlMock.mockResolvedValue({
    data: {
      signedUrl: 'https://supabase.local/signed-url',
      token: 'tok_abc',
      path: 'user-1/audit/bill.pdf',
    },
    error: null,
  });
});

describe('POST /api/audits — access gate', () => {
  it('user with active subscription: 200, audit row created, no decrement', async () => {
    assertCanRunAuditMock.mockResolvedValueOnce({
      ok: true,
      reason: 'subscription',
    });

    const res = await POST(
      makeRequest({ filename: 'bill.pdf', fileSize: 1024 }),
    );
    expect(res.status).toBe(200);

    expect(auditsInsertMock).toHaveBeenCalledTimes(1);
    expect(decrementMock).not.toHaveBeenCalled();
    expect(auditsDeleteEqMock).not.toHaveBeenCalled();
  });

  it('user with credits=2: 200, audit row created, decrement called', async () => {
    assertCanRunAuditMock.mockResolvedValueOnce({
      ok: true,
      reason: 'credit',
      remaining: 2,
    });
    decrementMock.mockResolvedValueOnce({ remaining: 1 });

    const res = await POST(
      makeRequest({ filename: 'bill.pdf', fileSize: 1024 }),
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      auditId: string;
      uploadUrl: string;
      storagePath: string;
      token: string;
    };
    // Response shape unchanged — credits aren't surfaced here.
    expect(typeof json.auditId).toBe('string');
    expect(json.uploadUrl).toBe('https://supabase.local/signed-url');
    expect(json.token).toBe('tok_abc');

    expect(auditsInsertMock).toHaveBeenCalledTimes(1);
    expect(decrementMock).toHaveBeenCalledTimes(1);
    expect(auditsDeleteEqMock).not.toHaveBeenCalled();
  });

  it('user with no plan: 402 with { error: "no_plan" } and no audit row', async () => {
    assertCanRunAuditMock.mockResolvedValueOnce({
      ok: false,
      reason: 'no_plan',
    });

    const res = await POST(
      makeRequest({ filename: 'bill.pdf', fileSize: 1024 }),
    );
    expect(res.status).toBe(402);

    const json = (await res.json()) as {
      error: string;
      upgrade_url?: string;
    };
    expect(json.error).toBe('no_plan');
    expect(json.upgrade_url).toBe('/pricing');

    expect(auditsInsertMock).not.toHaveBeenCalled();
    expect(decrementMock).not.toHaveBeenCalled();
  });

  it('user with past_due: 402 with { error: "subscription_past_due" }', async () => {
    assertCanRunAuditMock.mockResolvedValueOnce({
      ok: false,
      reason: 'past_due',
    });

    const res = await POST(
      makeRequest({ filename: 'bill.pdf', fileSize: 1024 }),
    );
    expect(res.status).toBe(402);

    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('subscription_past_due');

    expect(auditsInsertMock).not.toHaveBeenCalled();
    expect(decrementMock).not.toHaveBeenCalled();
  });

  it('decrement race (RPC throws): 402 + audit row deleted', async () => {
    assertCanRunAuditMock.mockResolvedValueOnce({
      ok: true,
      reason: 'credit',
      remaining: 1,
    });
    decrementMock.mockRejectedValueOnce(new Error('no_credits'));

    const res = await POST(
      makeRequest({ filename: 'bill.pdf', fileSize: 1024 }),
    );
    expect(res.status).toBe(402);

    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('no_plan');

    // The audit row was inserted, then deleted as part of rollback.
    expect(auditsInsertMock).toHaveBeenCalledTimes(1);
    expect(auditsDeleteEqMock).toHaveBeenCalledTimes(1);
    // No signed URL was issued for a rolled-back audit.
    expect(createSignedUploadUrlMock).not.toHaveBeenCalled();
  });
});
