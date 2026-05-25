import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Types ------------------------------------------------------------------

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

type AuditOwnerRow = { id: string; user_id: string };
type LineOwnershipRow = { id: string; audit_id: string };

type AuditMaybeSingleResult =
  | { data: AuditOwnerRow; error: null }
  | { data: null; error: null }
  | { data: null; error: { message: string } };

type LineMaybeSingleResult =
  | { data: LineOwnershipRow; error: null }
  | { data: null; error: null }
  | { data: null; error: { message: string } };

// --- Mocks ------------------------------------------------------------------

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const auditMaybeSingleMock = vi.fn<() => Promise<AuditMaybeSingleResult>>();
const lineMaybeSingleMock = vi.fn<() => Promise<LineMaybeSingleResult>>();
const updateChainMock =
  vi.fn<() => Promise<{ data: null; error: null | { message: string } }>>();

// audits: .from('audits').select(cols).eq('id', auditId).maybeSingle()
const auditSelectEqMock = vi.fn((_col: string, _val: string) => ({
  maybeSingle: () => auditMaybeSingleMock(),
}));
const auditSelectMock = vi.fn((_cols: string) => ({
  eq: (col: string, val: string) => auditSelectEqMock(col, val),
}));

// bill_lines (user-client): .select(cols).eq('id', lineId).eq('audit_id', auditId).maybeSingle()
const lineSelectEqEqMock = vi.fn(() => ({
  maybeSingle: () => lineMaybeSingleMock(),
}));
const lineSelectEqMock = vi.fn((_col: string, _val: string) => ({
  eq: (_c: string, _v: string) => lineSelectEqEqMock(),
}));
const lineSelectMock = vi.fn((_cols: string) => ({
  eq: (col: string, val: string) => lineSelectEqMock(col, val),
}));

// bill_lines (admin-client): .update(row).eq('id', lineId).eq('audit_id', auditId)
const updateEqEqMock = vi.fn(() => updateChainMock());
const updateEqMock = vi.fn((_col: string, _val: string) => ({
  eq: () => updateEqEqMock(),
}));
const updateMock = vi.fn((_row: Record<string, unknown>) => ({
  eq: (col: string, val: string) => updateEqMock(col, val),
}));

// Two `from` dispatchers — one for the user-scoped client (audits +
// bill_lines reads), one for the admin client (bill_lines update). They
// share the underlying table-specific mocks because the routes only call
// either `select` or `update` on each table at most once per request.
const userFromMock = vi.fn((table: string) => {
  if (table === 'audits') {
    return { select: (cols: string) => auditSelectMock(cols) };
  }
  if (table === 'bill_lines') {
    return { select: (cols: string) => lineSelectMock(cols) };
  }
  throw new Error(`unexpected user-client table: ${table}`);
});

const adminFromMock = vi.fn((table: string) => {
  if (table === 'bill_lines') {
    return { update: (row: Record<string, unknown>) => updateMock(row) };
  }
  throw new Error(`unexpected admin-client table: ${table}`);
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
    from: userFromMock,
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: adminFromMock }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

// Import after mocks.
import { POST } from '@/app/api/audits/[id]/lines/[lineId]/cost-center/route';

const VALID_AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const VALID_LINE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_USER_ID = 'user-uuid-1';

function makeContext(
  id: string,
  lineId: string,
): { params: Promise<{ id: string; lineId: string }> } {
  return { params: Promise.resolve({ id, lineId }) };
}

function makeRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/audits/${VALID_AUDIT_ID}/lines/${VALID_LINE_ID}/cost-center`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  getUserMock.mockReset();
  auditMaybeSingleMock.mockReset();
  lineMaybeSingleMock.mockReset();
  updateChainMock.mockReset();
  auditSelectEqMock.mockClear();
  auditSelectMock.mockClear();
  lineSelectEqEqMock.mockClear();
  lineSelectEqMock.mockClear();
  lineSelectMock.mockClear();
  updateEqEqMock.mockClear();
  updateEqMock.mockClear();
  updateMock.mockClear();
  userFromMock.mockClear();
  adminFromMock.mockClear();

  getUserMock.mockResolvedValue({
    data: { user: { id: OWNER_USER_ID, email: 'owner@example.com' } },
    error: null,
  });
  auditMaybeSingleMock.mockResolvedValue({
    data: { id: VALID_AUDIT_ID, user_id: OWNER_USER_ID },
    error: null,
  });
  lineMaybeSingleMock.mockResolvedValue({
    data: { id: VALID_LINE_ID, audit_id: VALID_AUDIT_ID },
    error: null,
  });
  updateChainMock.mockResolvedValue({ data: null, error: null });
});

describe('POST /api/audits/[id]/lines/[lineId]/cost-center', () => {
  it('returns 400 when the audit id is not a uuid', async () => {
    const res = await POST(
      makeRequest({ cost_center: 'Sales' }),
      makeContext('not-a-uuid', VALID_LINE_ID),
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the line id is not a uuid', async () => {
    const res = await POST(
      makeRequest({ cost_center: 'Sales' }),
      makeContext(VALID_AUDIT_ID, 'not-a-uuid'),
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = new Request(
      `http://localhost/api/audits/${VALID_AUDIT_ID}/lines/${VALID_LINE_ID}/cost-center`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      },
    );
    const res = await POST(req, makeContext(VALID_AUDIT_ID, VALID_LINE_ID));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when cost_center is not a string or null', async () => {
    const res = await POST(
      makeRequest({ cost_center: 42 }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when cost_center exceeds 80 chars', async () => {
    const res = await POST(
      makeRequest({ cost_center: 'x'.repeat(81) }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the body omits cost_center entirely', async () => {
    const res = await POST(
      makeRequest({}),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(
      makeRequest({ cost_center: 'Sales' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the audit is not found', async () => {
    auditMaybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(
      makeRequest({ cost_center: 'Sales' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the audit belongs to another user', async () => {
    auditMaybeSingleMock.mockResolvedValueOnce({
      data: { id: VALID_AUDIT_ID, user_id: 'someone-else' },
      error: null,
    });
    const res = await POST(
      makeRequest({ cost_center: 'Sales' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the line is not found within the audit', async () => {
    lineMaybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(
      makeRequest({ cost_center: 'Sales' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the audit lookup errors', async () => {
    auditMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    });
    const res = await POST(
      makeRequest({ cost_center: 'Sales' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(500);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the line lookup errors', async () => {
    lineMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    });
    const res = await POST(
      makeRequest({ cost_center: 'Sales' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(500);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the update fails', async () => {
    updateChainMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'db down' },
    });
    const res = await POST(
      makeRequest({ cost_center: 'Sales' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(500);
  });

  it('sets a cost_center on the happy path', async () => {
    const before = Date.now();
    const res = await POST(
      makeRequest({ cost_center: 'Sales' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(200);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['cost_center']).toBe('Sales');
    const updatedAt = arg['cost_center_updated_at'];
    expect(typeof updatedAt).toBe('string');
    const ts = Date.parse(updatedAt as string);
    expect(ts).toBeGreaterThanOrEqual(before - 1_000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1_000);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json['ok']).toBe(true);
  });

  it('clears the cost_center when the value is null', async () => {
    const res = await POST(
      makeRequest({ cost_center: null }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['cost_center']).toBeNull();
    expect(typeof arg['cost_center_updated_at']).toBe('string');
  });

  it('clears the cost_center when the value is an empty string', async () => {
    const res = await POST(
      makeRequest({ cost_center: '' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['cost_center']).toBeNull();
  });

  it('clears the cost_center when the value is whitespace only', async () => {
    const res = await POST(
      makeRequest({ cost_center: '   ' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['cost_center']).toBeNull();
  });

  it('trims leading and trailing whitespace before persisting', async () => {
    const res = await POST(
      makeRequest({ cost_center: '  Engineering  ' }),
      makeContext(VALID_AUDIT_ID, VALID_LINE_ID),
    );
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['cost_center']).toBe('Engineering');
  });
});
