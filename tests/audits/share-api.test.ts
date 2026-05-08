import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Types ------------------------------------------------------------------

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

type AuditTokenRow = {
  id: string;
  share_token: string | null;
};

type MaybeSingleResult =
  | { data: AuditTokenRow; error: null }
  | { data: null; error: null }
  | { data: null; error: { message: string } };

// --- Mocks ------------------------------------------------------------------

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const maybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();
const updateEqMock =
  vi.fn<() => Promise<{ data: null; error: null | { message: string } }>>();

const eqSelectMock = vi.fn(() => ({
  maybeSingle: () => maybeSingleMock(),
}));

const selectMock = vi.fn((_cols: string) => ({
  eq: (_col: string, _val: string) => eqSelectMock(),
}));

const updateMock = vi.fn((_row: Record<string, unknown>) => ({
  eq: (_col: string, _val: string) => updateEqMock(),
}));

const fromMock = vi.fn((_table: string) => ({
  select: (cols: string) => selectMock(cols),
  update: (row: Record<string, unknown>) => updateMock(row),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: () => getUserMock(),
    },
    from: fromMock,
  }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    NEXT_PUBLIC_APP_URL: 'https://app.carrieraudit.test',
  },
}));

// Import after mocks are registered.
import { POST } from '@/app/api/audits/[id]/share/route';

const VALID_AUDIT_ID = '11111111-1111-4111-8111-111111111111';

function makeContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): Request {
  return new Request(`http://localhost/api/audits/${VALID_AUDIT_ID}/share`, {
    method: 'POST',
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  maybeSingleMock.mockReset();
  updateEqMock.mockReset();
  eqSelectMock.mockClear();
  selectMock.mockClear();
  updateMock.mockClear();
  fromMock.mockClear();

  getUserMock.mockResolvedValue({
    data: { user: { id: 'user-uuid-1', email: 'test@example.com' } },
    error: null,
  });
  updateEqMock.mockResolvedValue({ data: null, error: null });
});

describe('POST /api/audits/[id]/share', () => {
  it('returns 401 when there is no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the audit id is not a uuid', async () => {
    const res = await POST(makeRequest(), makeContext('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the audit row is not found', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('generates a new token when the audit has no share_token', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { id: VALID_AUDIT_ID, share_token: null },
      error: null,
    });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(200);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const updateArg = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const generatedToken = updateArg['share_token'];
    expect(typeof generatedToken).toBe('string');
    expect((generatedToken as string).length).toBeGreaterThanOrEqual(16);

    const json = (await res.json()) as Record<string, unknown>;
    expect(typeof json['url']).toBe('string');
    expect(json['url']).toBe(
      `https://app.carrieraudit.test/share/${generatedToken as string}`,
    );
  });

  it('returns the existing token without regenerating when one exists', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { id: VALID_AUDIT_ID, share_token: 'existing-token-123' },
      error: null,
    });
    const res = await POST(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(200);

    expect(updateMock).not.toHaveBeenCalled();

    const json = (await res.json()) as Record<string, unknown>;
    expect(json['url']).toBe(
      'https://app.carrieraudit.test/share/existing-token-123',
    );
  });
});
