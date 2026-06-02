import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Types ------------------------------------------------------------------

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

type FindingOwnershipRow = {
  id: string;
  audit_id: string;
  audits: { id: string; user_id: string } | null;
};

type MaybeSingleResult =
  | { data: FindingOwnershipRow; error: null }
  | { data: null; error: null }
  | { data: null; error: { message: string } };

// --- Mocks ------------------------------------------------------------------
// Order matters: mocks must be registered BEFORE importing the route.

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const maybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();
const updateChainMock = vi.fn<() => Promise<{ data: null; error: null | { message: string } }>>();

// `.from('findings').select(...).eq(...).eq(...).maybeSingle()`
const selectEqEqMock = vi.fn(() => ({
  maybeSingle: () => maybeSingleMock(),
}));
const selectEqMock = vi.fn((_col: string, _val: string) => ({
  eq: (_c: string, _v: string) => selectEqEqMock(),
}));
const selectMock = vi.fn((_cols: string) => ({
  eq: (col: string, val: string) => selectEqMock(col, val),
}));

// `.from('findings').update(row).eq(...).eq(...)`
const updateEqEqMock = vi.fn((_c: string, _v: string) => updateChainMock());
const updateEqMock = vi.fn((_col: string, _val: string) => ({
  eq: (c: string, v: string) => updateEqEqMock(c, v),
}));
const updateMock = vi.fn((_row: Record<string, unknown>) => ({
  eq: (col: string, val: string) => updateEqMock(col, val),
}));

const fromMock = vi.fn((_table: string) => ({
  select: (cols: string) => selectMock(cols),
  update: (row: Record<string, unknown>) => updateMock(row),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
    from: fromMock,
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: fromMock }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

// The route fires a `finding.status_changed` Inngest event after a successful
// update. Stub it so tests don't try to talk to a real Inngest endpoint.
vi.mock('@/inngest/client', () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));

// Import after mocks.
import { POST } from '@/app/api/audits/[id]/findings/[findingId]/status/route';

const VALID_AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const VALID_FINDING_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_USER_ID = 'user-uuid-1';

function makeContext(
  id: string,
  findingId: string,
): { params: Promise<{ id: string; findingId: string }> } {
  return { params: Promise.resolve({ id, findingId }) };
}

function makeRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/audits/${VALID_AUDIT_ID}/findings/${VALID_FINDING_ID}/status`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  getUserMock.mockReset();
  maybeSingleMock.mockReset();
  updateChainMock.mockReset();
  selectEqEqMock.mockClear();
  selectEqMock.mockClear();
  selectMock.mockClear();
  updateEqEqMock.mockClear();
  updateEqMock.mockClear();
  updateMock.mockClear();
  fromMock.mockClear();

  getUserMock.mockResolvedValue({
    data: { user: { id: OWNER_USER_ID, email: 'test@example.com' } },
    error: null,
  });
  updateChainMock.mockResolvedValue({ data: null, error: null });
  maybeSingleMock.mockResolvedValue({
    data: {
      id: VALID_FINDING_ID,
      audit_id: VALID_AUDIT_ID,
      audits: { id: VALID_AUDIT_ID, user_id: OWNER_USER_ID },
    },
    error: null,
  });
});

describe('POST /api/audits/[id]/findings/[findingId]/status', () => {
  it('returns 400 when the audit id is not a uuid', async () => {
    const res = await POST(
      makeRequest({ status: 'approved' }),
      makeContext('not-a-uuid', VALID_FINDING_ID),
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the finding id is not a uuid', async () => {
    const res = await POST(
      makeRequest({ status: 'approved' }),
      makeContext(VALID_AUDIT_ID, 'not-a-uuid'),
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = new Request(
      `http://localhost/api/audits/${VALID_AUDIT_ID}/findings/${VALID_FINDING_ID}/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      },
    );
    const res = await POST(req, makeContext(VALID_AUDIT_ID, VALID_FINDING_ID));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when status is not in the allowed enum', async () => {
    const res = await POST(
      makeRequest({ status: 'frobnicated' }),
      makeContext(VALID_AUDIT_ID, VALID_FINDING_ID),
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when note exceeds 500 chars', async () => {
    const res = await POST(
      makeRequest({ status: 'approved', note: 'x'.repeat(501) }),
      makeContext(VALID_AUDIT_ID, VALID_FINDING_ID),
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(
      makeRequest({ status: 'approved' }),
      makeContext(VALID_AUDIT_ID, VALID_FINDING_ID),
    );
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the finding is not found', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(
      makeRequest({ status: 'approved' }),
      makeContext(VALID_AUDIT_ID, VALID_FINDING_ID),
    );
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the finding belongs to another user', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: VALID_FINDING_ID,
        audit_id: VALID_AUDIT_ID,
        audits: { id: VALID_AUDIT_ID, user_id: 'someone-else' },
      },
      error: null,
    });
    const res = await POST(
      makeRequest({ status: 'approved' }),
      makeContext(VALID_AUDIT_ID, VALID_FINDING_ID),
    );
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the ownership lookup errors', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    });
    const res = await POST(
      makeRequest({ status: 'approved' }),
      makeContext(VALID_AUDIT_ID, VALID_FINDING_ID),
    );
    expect(res.status).toBe(500);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 500 and does NOT echo the review note when the update fails', async () => {
    updateChainMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'db down' },
    });
    const res = await POST(
      makeRequest({ status: 'approved', note: 'sensitive review content' }),
      makeContext(VALID_AUDIT_ID, VALID_FINDING_ID),
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(json).includes('sensitive review content')).toBe(false);
  });

  it('updates the finding with status, timestamps, user, and null note on the happy path', async () => {
    const before = Date.now();
    const res = await POST(
      makeRequest({ status: 'approved' }),
      makeContext(VALID_AUDIT_ID, VALID_FINDING_ID),
    );
    expect(res.status).toBe(200);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['status']).toBe('approved');
    expect(arg['status_updated_by']).toBe(OWNER_USER_ID);
    expect(arg['review_note']).toBeNull();
    const updatedAt = arg['status_updated_at'];
    expect(typeof updatedAt).toBe('string');
    const ts = Date.parse(updatedAt as string);
    expect(ts).toBeGreaterThanOrEqual(before - 1_000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1_000);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json['ok']).toBe(true);
  });

  it('persists the review note when provided', async () => {
    const res = await POST(
      makeRequest({ status: 'in_review', note: 'pending account review' }),
      makeContext(VALID_AUDIT_ID, VALID_FINDING_ID),
    );
    expect(res.status).toBe(200);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['review_note']).toBe('pending account review');
    expect(arg['status']).toBe('in_review');
  });

  it('accepts every documented status (liberal any-to-any transitions)', async () => {
    const statuses = ['new', 'in_review', 'approved', 'rejected', 'disputed', 'resolved'] as const;
    for (const status of statuses) {
      const res = await POST(
        makeRequest({ status }),
        makeContext(VALID_AUDIT_ID, VALID_FINDING_ID),
      );
      expect(res.status).toBe(200);
    }
    expect(updateMock).toHaveBeenCalledTimes(statuses.length);
  });
});
