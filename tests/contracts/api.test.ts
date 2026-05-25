import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-handler tests for the contracts API surface:
 *   - POST /api/contracts                    happy-path + auth
 *   - PATCH /api/contracts/[id]/terms        happy-path + ownership
 *
 * Mocks Supabase server + admin clients per the established pattern in
 * tests/audits/api.test.ts. No real DB / no real Anthropic.
 */

// ─── Shared types ───────────────────────────────────────────────────────────
type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

// ─── Mocks (hoisted) ────────────────────────────────────────────────────────
const {
  getUserMock,
  contractsInsertMock,
  contractsDeleteEqMock,
  createSignedUploadUrlMock,
  termsLookupMock,
  termsUpdateMock,
  termsInsertMock,
  contractLookupMock,
} = vi.hoisted(() => {
  return {
    getUserMock: vi.fn<() => Promise<GetUserResult>>(),
    contractsInsertMock: vi.fn(async (_row: unknown) => ({
      data: null,
      error: null,
    })),
    contractsDeleteEqMock: vi.fn(async () => ({ data: null, error: null })),
    createSignedUploadUrlMock: vi.fn(async (_path: string) => ({
      data: {
        signedUrl: 'https://supabase.local/signed',
        token: 'tok',
        path: 'x/y/z.pdf',
      },
      error: null as null | { message: string },
    })),
    termsLookupMock: vi.fn(async () => ({
      data: null as { id: string } | null,
      error: null as null | { message: string },
    })),
    termsUpdateMock: vi.fn(async () => ({
      data: null,
      error: null as null | { message: string },
    })),
    termsInsertMock: vi.fn(async () => ({
      data: null,
      error: null as null | { message: string },
    })),
    contractLookupMock: vi.fn(async () => ({
      data: null as { id: string; user_id: string } | null,
      error: null as null | { message: string },
    })),
  };
});

// `from('contracts').insert(row)` + `from('contracts').delete().eq(...)`
// `from('contracts').select().eq().maybeSingle()` (RLS-scoped lookup)
// `from('contract_terms').select().eq().maybeSingle()` / update / insert
const adminFromMock = vi.fn((table: string) => {
  if (table === 'contracts') {
    return {
      insert: (row: unknown) => contractsInsertMock(row),
      delete: () => ({
        eq: () => contractsDeleteEqMock(),
      }),
    };
  }
  // contract_terms
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: () => termsLookupMock(),
      }),
    }),
    update: () => ({
      eq: () => termsUpdateMock(),
    }),
    insert: () => termsInsertMock(),
  };
});

const serverFromMock = vi.fn((_table: string) => ({
  select: () => ({
    eq: () => ({
      maybeSingle: () => contractLookupMock(),
    }),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
    from: serverFromMock,
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: adminFromMock,
    storage: {
      from: (_bucket: string) => ({
        createSignedUploadUrl: (path: string) => createSignedUploadUrlMock(path),
      }),
    },
  }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    ANTHROPIC_API_KEY: 'placeholder',
  },
}));

// Import routes after mocks register.
import { POST as POST_create } from '@/app/api/contracts/route';
import { PATCH as PATCH_terms } from '@/app/api/contracts/[id]/terms/route';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const TEST_CONTRACT_ID = '33333333-3333-4333-8333-333333333333';

function makeJsonRequest(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  contractsInsertMock.mockClear();
  contractsDeleteEqMock.mockClear();
  createSignedUploadUrlMock.mockClear();
  termsLookupMock.mockReset();
  termsUpdateMock.mockReset();
  termsInsertMock.mockReset();
  contractLookupMock.mockReset();

  getUserMock.mockResolvedValue({
    data: { user: { id: TEST_USER_ID, email: 'test@example.com' } },
    error: null,
  });
  contractsInsertMock.mockResolvedValue({ data: null, error: null });
  createSignedUploadUrlMock.mockResolvedValue({
    data: {
      signedUrl: 'https://supabase.local/signed',
      token: 'tok',
      path: 'x/y/z.pdf',
    },
    error: null,
  });
  termsLookupMock.mockResolvedValue({ data: null, error: null });
  termsUpdateMock.mockResolvedValue({ data: null, error: null });
  termsInsertMock.mockResolvedValue({ data: null, error: null });
  contractLookupMock.mockResolvedValue({
    data: { id: TEST_CONTRACT_ID, user_id: TEST_USER_ID },
    error: null,
  });
});

describe('POST /api/contracts', () => {
  it('happy path: creates a contract row + returns signed upload URL', async () => {
    const req = makeJsonRequest('http://localhost/api/contracts', {
      filename: 'contract.pdf',
      size_bytes: 1024,
    });
    const res = await POST_create(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.contractId).toBe('string');
    expect(typeof body.uploadUrl).toBe('string');
    expect(typeof body.storagePath).toBe('string');

    expect(contractsInsertMock).toHaveBeenCalledTimes(1);
    const insertArgs = contractsInsertMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(insertArgs?.user_id).toBe(TEST_USER_ID);
    expect(insertArgs?.status).toBe('pending');
    expect(insertArgs?.original_filename).toBe('contract.pdf');
    expect(createSignedUploadUrlMock).toHaveBeenCalledTimes(1);
  });

  it('returns 401 when no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const req = makeJsonRequest('http://localhost/api/contracts', {
      filename: 'contract.pdf',
      size_bytes: 1024,
    });
    const res = await POST_create(req);
    expect(res.status).toBe(401);
    expect(contractsInsertMock).not.toHaveBeenCalled();
  });

  it('returns 400 when filename has an unsupported extension', async () => {
    const req = makeJsonRequest('http://localhost/api/contracts', {
      filename: 'contract.docx',
      size_bytes: 1024,
    });
    const res = await POST_create(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when size exceeds 25 MB cap', async () => {
    const req = makeJsonRequest('http://localhost/api/contracts', {
      filename: 'contract.pdf',
      size_bytes: 26 * 1024 * 1024,
    });
    const res = await POST_create(req);
    expect(res.status).toBe(400);
  });

  it('rolls back the inserted row when signed-URL creation fails', async () => {
    createSignedUploadUrlMock.mockResolvedValueOnce({
      data: null as never,
      error: { message: 'storage offline' },
    });
    const req = makeJsonRequest('http://localhost/api/contracts', {
      filename: 'contract.pdf',
      size_bytes: 1024,
    });
    const res = await POST_create(req);
    expect(res.status).toBe(500);
    expect(contractsDeleteEqMock).toHaveBeenCalled();
  });
});

describe('PATCH /api/contracts/[id]/terms', () => {
  function makeContext(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it('happy path (existing terms row): runs UPDATE and returns 200', async () => {
    termsLookupMock.mockResolvedValueOnce({ data: { id: 'terms-1' }, error: null });
    const req = makeJsonRequest(
      `http://localhost/api/contracts/${TEST_CONTRACT_ID}/terms`,
      { plan_name: 'Business Unlimited Pro 2.0' },
      'PATCH',
    );
    const res = await PATCH_terms(req, makeContext(TEST_CONTRACT_ID));
    expect(res.status).toBe(200);
    expect(termsUpdateMock).toHaveBeenCalledTimes(1);
    expect(termsInsertMock).not.toHaveBeenCalled();
  });

  it('happy path (no terms row yet): runs INSERT and returns 200', async () => {
    termsLookupMock.mockResolvedValueOnce({ data: null, error: null });
    const req = makeJsonRequest(
      `http://localhost/api/contracts/${TEST_CONTRACT_ID}/terms`,
      { contracted_monthly_rate_cents: 4500 },
      'PATCH',
    );
    const res = await PATCH_terms(req, makeContext(TEST_CONTRACT_ID));
    expect(res.status).toBe(200);
    expect(termsInsertMock).toHaveBeenCalledTimes(1);
    expect(termsUpdateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the contract is owned by another user', async () => {
    contractLookupMock.mockResolvedValueOnce({
      data: { id: TEST_CONTRACT_ID, user_id: OTHER_USER_ID },
      error: null,
    });
    const req = makeJsonRequest(
      `http://localhost/api/contracts/${TEST_CONTRACT_ID}/terms`,
      { plan_name: 'X' },
      'PATCH',
    );
    const res = await PATCH_terms(req, makeContext(TEST_CONTRACT_ID));
    expect(res.status).toBe(404);
    expect(termsUpdateMock).not.toHaveBeenCalled();
    expect(termsInsertMock).not.toHaveBeenCalled();
  });

  it('returns 401 when no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const req = makeJsonRequest(
      `http://localhost/api/contracts/${TEST_CONTRACT_ID}/terms`,
      { plan_name: 'X' },
      'PATCH',
    );
    const res = await PATCH_terms(req, makeContext(TEST_CONTRACT_ID));
    expect(res.status).toBe(401);
  });

  it('returns 400 when body fails Zod (e.g. negative monthly rate)', async () => {
    const req = makeJsonRequest(
      `http://localhost/api/contracts/${TEST_CONTRACT_ID}/terms`,
      { contracted_monthly_rate_cents: -100 },
      'PATCH',
    );
    const res = await PATCH_terms(req, makeContext(TEST_CONTRACT_ID));
    expect(res.status).toBe(400);
    expect(termsUpdateMock).not.toHaveBeenCalled();
    expect(termsInsertMock).not.toHaveBeenCalled();
  });

  it('treats an empty patch object as a successful no-op (no DB write)', async () => {
    const req = makeJsonRequest(
      `http://localhost/api/contracts/${TEST_CONTRACT_ID}/terms`,
      {},
      'PATCH',
    );
    const res = await PATCH_terms(req, makeContext(TEST_CONTRACT_ID));
    expect(res.status).toBe(200);
    expect(termsUpdateMock).not.toHaveBeenCalled();
    expect(termsInsertMock).not.toHaveBeenCalled();
  });
});
