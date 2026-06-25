import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

// --- Mocks --------------------------------------------------------------
// These must be declared before importing the route under test.

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
const createSignedUploadUrlMock = vi.fn<(path: string) => Promise<SignedUrlResult>>();

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
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: fromMock,
    storage: {
      from: storageFromMock,
    },
  }),
}));

// The Phase 4 access gate runs before the audit is created. Its own behavior
// is covered by tests/access/*; here we just stub it to "subscription" so the
// pre-existing happy-path / error-path tests behave as they did before.
vi.mock('@/lib/access/gate', () => ({
  assertCanRunAudit: async () => ({ ok: true, reason: 'subscription' }),
}));

vi.mock('@/lib/access/decrement', () => ({
  decrementAuditCreditAtomically: async () => ({ remaining: 0 }),
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

  // Sensible defaults; individual tests override as needed.
  getUserMock.mockResolvedValue({
    data: { user: { id: TEST_USER_ID, email: 'test@example.com' } },
    error: null,
  });
  auditsInsertMock.mockResolvedValue({ data: null, error: null });
  createSignedUploadUrlMock.mockResolvedValue({
    data: {
      signedUrl: 'https://supabase.local/signed-url',
      token: 'tok_abc',
      path: `${TEST_USER_ID}/audit/bill.pdf`,
    },
    error: null,
  });
});

describe('POST /api/audits', () => {
  it('returns 400 when filename is missing', async () => {
    const res = await POST(makeRequest({ fileSize: 12345 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when file size exceeds 25 MB', async () => {
    const res = await POST(makeRequest({ filename: 'bill.pdf', fileSize: 26 * 1024 * 1024 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when filename is not a PDF', async () => {
    const res = await POST(makeRequest({ filename: 'bill.docx', fileSize: 1024 }));
    expect(res.status).toBe(400);
  });

  it('returns 401 when there is no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });

    const res = await POST(makeRequest({ filename: 'bill.pdf', fileSize: 12345 }));
    expect(res.status).toBe(401);
  });

  it('returns auditId and uploadUrl on the happy path', async () => {
    const res = await POST(makeRequest({ filename: 'bill.pdf', fileSize: 12345 }));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      auditId: string;
      uploadUrl: string;
      storagePath: string;
      token: string;
    };

    expect(typeof json.auditId).toBe('string');
    expect(json.auditId.length).toBeGreaterThan(0);
    expect(json.uploadUrl).toBe('https://supabase.local/signed-url');
    expect(json.token).toBe('tok_abc');
    expect(json.storagePath.startsWith(`${TEST_USER_ID}/`)).toBe(true);
    expect(json.storagePath.endsWith('/bill.pdf')).toBe(true);

    // Confirm we wrote an audits row with the expected shape.
    expect(auditsInsertMock).toHaveBeenCalledTimes(1);
    const inserted = auditsInsertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted['user_id']).toBe(TEST_USER_ID);
    expect(inserted['status']).toBe('pending');
    expect(inserted['original_filename']).toBe('bill.pdf');
    expect(inserted['file_size_bytes']).toBe(12345);
    expect(typeof inserted['storage_path']).toBe('string');
    expect(typeof inserted['id']).toBe('string');

    // And we requested a signed upload URL for the same storage path.
    expect(createSignedUploadUrlMock).toHaveBeenCalledTimes(1);
    expect(createSignedUploadUrlMock.mock.calls[0]?.[0]).toBe(inserted['storage_path']);
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = new Request('http://localhost/api/audits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
