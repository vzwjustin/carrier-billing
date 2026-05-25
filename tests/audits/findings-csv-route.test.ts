import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Types — shapes of what the mocked Supabase chain returns.
// ---------------------------------------------------------------------------

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

interface AuditAuthRow {
  id: string;
  user_id: string;
  status: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  share_token: string | null;
  share_token_expires_at: string | null;
}

interface FindingDbRow {
  rule_id: string;
  severity: string;
  status: string | null;
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number;
  confidence: number;
  affected_line_ids: string[] | null;
  affected_account_ids: string[] | null;
}

// ---------------------------------------------------------------------------
// Mocks (registered before route import).
// ---------------------------------------------------------------------------

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const auditMaybeSingleMock =
  vi.fn<() => Promise<{ data: AuditAuthRow | null; error: null | { message: string } }>>();
const findingsResolveMock =
  vi.fn<() => Promise<{ data: FindingDbRow[]; error: null | { message: string } }>>();

// Capture the .in() calls so tests can assert which filters were applied.
const inCalls: Array<{ column: string; values: string[] }> = [];

function makeFindingsChain() {
  // The route does:
  //   admin.from('findings').select(...).eq('audit_id', id)
  //     [.in('status', [...])]?
  //     [.in('severity', [...])]?
  // then `await` resolves the chain.
  //
  // We model the chain as a thenable that captures `.in()` invocations.
  const chain = {
    in(column: string, values: string[]) {
      inCalls.push({ column, values });
      return chain;
    },
    then<T>(resolve: (v: { data: FindingDbRow[]; error: null | { message: string } }) => T) {
      return findingsResolveMock().then(resolve);
    },
  };
  return chain;
}

const fromMock = vi.fn((table: string) => {
  if (table === 'audits') {
    return {
      select: () => ({
        eq: (_c: string, _v: string) => ({
          eq: () => ({ maybeSingle: () => auditMaybeSingleMock() }),
          maybeSingle: () => auditMaybeSingleMock(),
        }),
      }),
    };
  }
  if (table === 'findings') {
    return {
      select: () => ({
        eq: () => makeFindingsChain(),
      }),
    };
  }
  throw new Error(`unexpected table: ${table}`);
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
    from: fromMock,
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: fromMock }),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: async () => ({ ok: true, resetAt: new Date().toISOString() }),
  rateLimitedResponse: () => new Response('rate-limited', { status: 429 }),
}));

vi.mock('@/lib/analytics/hash', () => ({
  hashTokenForAnalytics: (t: string) => `hashed:${t.slice(0, 4)}`,
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

// Import AFTER mocks.
import { GET } from '@/app/api/audits/[id]/findings.csv/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-uuid-1';

function makeContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(qs: string = ''): Request {
  const url = `http://localhost/api/audits/${AUDIT_ID}/findings.csv${qs ? `?${qs}` : ''}`;
  return new Request(url, { method: 'GET' });
}

function defaultAudit(): AuditAuthRow {
  return {
    id: AUDIT_ID,
    user_id: USER_ID,
    status: 'completed',
    carrier: 'verizon',
    billing_period_start: '2025-01-01',
    billing_period_end: '2025-01-31',
    share_token: null,
    share_token_expires_at: null,
  };
}

function defaultFindings(): FindingDbRow[] {
  return [
    {
      rule_id: 'r_high',
      severity: 'high',
      status: 'approved',
      title: 'Big leak',
      description: 'a',
      recommended_action: 'fix',
      estimated_monthly_savings_cents: 1000,
      confidence: 0.9,
      affected_line_ids: ['line-1', 'line-2'],
      affected_account_ids: ['acct-1'],
    },
    {
      rule_id: 'r_low',
      severity: 'low',
      status: 'new',
      title: 'Tiny waste',
      description: 'b',
      recommended_action: 'fix',
      estimated_monthly_savings_cents: 100,
      confidence: 0.5,
      affected_line_ids: null,
      affected_account_ids: null,
    },
  ];
}

beforeEach(() => {
  inCalls.length = 0;
  getUserMock.mockReset();
  auditMaybeSingleMock.mockReset();
  findingsResolveMock.mockReset();
  fromMock.mockClear();

  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID } },
    error: null,
  });
  auditMaybeSingleMock.mockResolvedValue({ data: defaultAudit(), error: null });
  findingsResolveMock.mockResolvedValue({ data: defaultFindings(), error: null });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/audits/[id]/findings.csv', () => {
  it('returns 400 when audit id is not a uuid', async () => {
    const res = await GET(makeRequest(), makeContext('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('returns the CSV with the expected header columns', async () => {
    const res = await GET(makeRequest(), makeContext(AUDIT_ID));
    expect(res.status).toBe(200);
    const body = await res.text();
    const firstLine = body.split('\r\n')[0];
    expect(firstLine).toBe(
      'rule_id,severity,status,title,description,recommended_action,estimated_monthly_savings_dollars,estimated_annual_savings_dollars,confidence,affected_line_count,affected_account_count',
    );
  });

  it('emits status, affected_line_count, and affected_account_count for each row', async () => {
    const res = await GET(makeRequest(), makeContext(AUDIT_ID));
    expect(res.status).toBe(200);
    const body = await res.text();
    const rows = body.split('\r\n');
    // Header + 2 data rows.
    expect(rows).toHaveLength(3);
    // High row sorted first; check status, line count, account count.
    const high = rows[1]?.split(',') ?? [];
    expect(high[0]).toBe('r_high');
    expect(high[1]).toBe('high');
    expect(high[2]).toBe('approved');
    // affected_line_count = 2 (last-two columns: lines, accounts).
    expect(high.at(-2)).toBe('2');
    expect(high.at(-1)).toBe('1');

    const low = rows[2]?.split(',') ?? [];
    expect(low[0]).toBe('r_low');
    expect(low[2]).toBe('new');
    expect(low.at(-2)).toBe('0');
    expect(low.at(-1)).toBe('0');
  });

  it('falls back to "new" when the DB column is null on a legacy row', async () => {
    findingsResolveMock.mockResolvedValueOnce({
      data: [
        {
          ...defaultFindings()[0]!,
          rule_id: 'r_legacy',
          status: null,
        },
      ],
      error: null,
    });
    const res = await GET(makeRequest(), makeContext(AUDIT_ID));
    const body = await res.text();
    const row = body.split('\r\n')[1]?.split(',') ?? [];
    expect(row[0]).toBe('r_legacy');
    expect(row[2]).toBe('new');
  });

  it('applies ?status=approved,disputed as an IN filter at the DB layer', async () => {
    const res = await GET(
      makeRequest('status=approved,disputed'),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(200);
    expect(inCalls).toContainEqual({
      column: 'status',
      values: ['approved', 'disputed'],
    });
    // No severity filter requested:
    expect(inCalls.some((c) => c.column === 'severity')).toBe(false);
  });

  it('applies ?severity=high,medium as an IN filter at the DB layer', async () => {
    const res = await GET(
      makeRequest('severity=high,medium'),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(200);
    expect(inCalls).toContainEqual({
      column: 'severity',
      values: ['high', 'medium'],
    });
  });

  it('combines ?status and ?severity as two IN filters', async () => {
    const res = await GET(
      makeRequest('status=approved&severity=high'),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(200);
    expect(inCalls.some((c) => c.column === 'status')).toBe(true);
    expect(inCalls.some((c) => c.column === 'severity')).toBe(true);
  });

  it('returns 400 when ?status contains an unknown value', async () => {
    const res = await GET(
      makeRequest('status=approved,frobnicated'),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(400);
    expect(inCalls).toHaveLength(0);
  });

  it('returns 400 when ?severity contains an unknown value', async () => {
    const res = await GET(
      makeRequest('severity=high,nuclear'),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(400);
    expect(inCalls).toHaveLength(0);
  });

  it('returns an empty body (header only) when the filter has zero values', async () => {
    // `?status=` is present but has no values → "filter on, allow nothing".
    const res = await GET(makeRequest('status='), makeContext(AUDIT_ID));
    expect(res.status).toBe(200);
    const body = await res.text();
    // Only the header row, no data rows.
    expect(body.split('\r\n')).toHaveLength(1);
    // We short-circuited before issuing the findings IN filter.
    expect(inCalls).toHaveLength(0);
  });

  it('returns 401 with no token and no auth user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET(makeRequest(), makeContext(AUDIT_ID));
    expect(res.status).toBe(401);
  });

  it('returns 409 when the audit is not completed', async () => {
    auditMaybeSingleMock.mockResolvedValueOnce({
      data: { ...defaultAudit(), status: 'pending' },
      error: null,
    });
    const res = await GET(makeRequest(), makeContext(AUDIT_ID));
    expect(res.status).toBe(409);
  });
});
