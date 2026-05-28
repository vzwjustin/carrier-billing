import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Types — shapes the mocked Supabase chain returns.
// ---------------------------------------------------------------------------

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

interface AuditRow {
  id: string;
  user_id: string;
  status: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
}

interface FindingRow {
  id: string;
  audit_id: string;
  rule_id: string;
  severity: 'high' | 'medium' | 'low' | 'info';
  status: string;
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number;
  confidence: number;
  affected_line_ids: string[] | null;
  affected_account_ids: string[] | null;
}

interface LineRow {
  id: string;
  mdn_masked: string | null;
  plan_name: string | null;
}

interface AccountRow {
  id: string;
  account_number_masked: string | null;
  account_label: string | null;
}

interface ProfileRow {
  full_name: string | null;
}

// ---------------------------------------------------------------------------
// Mocks (registered before route import).
// ---------------------------------------------------------------------------

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const auditMaybeSingleMock =
  vi.fn<() => Promise<{ data: AuditRow | null; error: null | { message: string } }>>();
const profileMaybeSingleMock =
  vi.fn<() => Promise<{ data: ProfileRow | null; error: null | { message: string } }>>();

// `findings`.in() resolver — captures the .in('id', [...]) the route makes.
const findingsInCalls: string[][] = [];
const findingsResolveMock =
  vi.fn<() => Promise<{ data: FindingRow[]; error: null | { message: string } }>>();

// `bill_lines`.in() resolver — captures the .in('id', [...]) call.
const linesInCalls: string[][] = [];
const linesResolveMock =
  vi.fn<() => Promise<{ data: LineRow[]; error: null | { message: string } }>>();

// `bill_accounts`.in() resolver — captures the .in('id', [...]) call.
const accountsInCalls: string[][] = [];
const accountsResolveMock =
  vi.fn<() => Promise<{ data: AccountRow[]; error: null | { message: string } }>>();

function makeFindingsChain() {
  // .from('findings').select(...).eq('audit_id', id).in('id', ids) then await.
  const chain = {
    in(_column: string, values: string[]) {
      findingsInCalls.push(values);
      return chain;
    },
    then<T>(
      resolve: (v: {
        data: FindingRow[];
        error: null | { message: string };
      }) => T,
    ) {
      return findingsResolveMock().then(resolve);
    },
  };
  return chain;
}

function makeLinesChain() {
  const chain = {
    in(_column: string, values: string[]) {
      linesInCalls.push(values);
      return chain;
    },
    then<T>(
      resolve: (v: {
        data: LineRow[];
        error: null | { message: string };
      }) => T,
    ) {
      return linesResolveMock().then(resolve);
    },
  };
  return chain;
}

function makeAccountsChain() {
  const chain = {
    in(_column: string, values: string[]) {
      accountsInCalls.push(values);
      return chain;
    },
    then<T>(
      resolve: (v: {
        data: AccountRow[];
        error: null | { message: string };
      }) => T,
    ) {
      return accountsResolveMock().then(resolve);
    },
  };
  return chain;
}

const fromMock = vi.fn((table: string) => {
  if (table === 'audits') {
    return {
      select: () => ({
        eq: () => ({ maybeSingle: () => auditMaybeSingleMock() }),
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
  if (table === 'bill_lines') {
    return {
      select: () => ({
        eq: () => makeLinesChain(),
      }),
    };
  }
  if (table === 'bill_accounts') {
    return {
      select: () => ({
        eq: () => makeAccountsChain(),
      }),
    };
  }
  if (table === 'profiles') {
    return {
      select: () => ({
        eq: () => ({ maybeSingle: () => profileMaybeSingleMock() }),
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
  consumeRateLimit: async () => ({
    ok: true,
    resetAt: new Date().toISOString(),
  }),
  rateLimitedResponse: () => new Response('rate-limited', { status: 429 }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

// Stub out the @react-pdf/renderer-backed bulk renderer so the route test
// stays fast and doesn't pull in headless Chrome / fontkit etc.
vi.mock('@/disputes/pdf/bulk-render', () => ({
  renderBulkDisputePdf: vi.fn(async () => Buffer.from('PDF', 'utf8')),
}));

// Import AFTER mocks.
import { GET } from '@/app/api/audits/[id]/dispute-letter.pdf/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FINDING_A = '33333333-3333-4333-8333-333333333333';
const FINDING_B = '44444444-4444-4444-8444-444444444444';
const FINDING_C = '55555555-5555-4555-8555-555555555555';
const LINE_A = '66666666-6666-4666-8666-666666666666';
const ACCOUNT_A = '77777777-7777-4777-8777-777777777777';

function makeContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(qs: string = ''): Request {
  const url = `http://localhost/api/audits/${AUDIT_ID}/dispute-letter.pdf${qs ? `?${qs}` : ''}`;
  return new Request(url, { method: 'GET' });
}

function defaultAudit(): AuditRow {
  return {
    id: AUDIT_ID,
    user_id: USER_ID,
    status: 'completed',
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
  };
}

function approvedFinding(
  id: string,
  rule_id: string,
  cents: number,
): FindingRow {
  return {
    id,
    audit_id: AUDIT_ID,
    rule_id,
    severity: 'high',
    status: 'approved',
    title: `Finding ${rule_id}`,
    description: `Desc for ${rule_id}`,
    recommended_action: `Act on ${rule_id}`,
    estimated_monthly_savings_cents: cents,
    confidence: 0.9,
    affected_line_ids: [LINE_A],
    affected_account_ids: [ACCOUNT_A],
  };
}

beforeEach(() => {
  findingsInCalls.length = 0;
  linesInCalls.length = 0;
  accountsInCalls.length = 0;

  getUserMock.mockReset();
  auditMaybeSingleMock.mockReset();
  profileMaybeSingleMock.mockReset();
  findingsResolveMock.mockReset();
  linesResolveMock.mockReset();
  accountsResolveMock.mockReset();
  fromMock.mockClear();

  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID, email: 'op@example.com' } },
    error: null,
  });
  auditMaybeSingleMock.mockResolvedValue({
    data: defaultAudit(),
    error: null,
  });
  profileMaybeSingleMock.mockResolvedValue({
    data: { full_name: 'Pat Operator' },
    error: null,
  });
  findingsResolveMock.mockResolvedValue({
    data: [
      approvedFinding(FINDING_A, 'rule_a', 1000),
      approvedFinding(FINDING_B, 'rule_b', 2500),
    ],
    error: null,
  });
  linesResolveMock.mockResolvedValue({
    data: [{ id: LINE_A, mdn_masked: '5551', plan_name: 'BizPlan' }],
    error: null,
  });
  accountsResolveMock.mockResolvedValue({
    data: [
      {
        id: ACCOUNT_A,
        account_number_masked: '7890',
        account_label: 'Main',
      },
    ],
    error: null,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/audits/[id]/dispute-letter.pdf', () => {
  it('returns 400 when audit id is not a uuid', async () => {
    const res = await GET(
      makeRequest(`finding_ids=${FINDING_A}`),
      makeContext('not-a-uuid'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when finding_ids is missing', async () => {
    const res = await GET(makeRequest(), makeContext(AUDIT_ID));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('finding_ids');
  });

  it('returns 400 when finding_ids contains a non-UUID value', async () => {
    const res = await GET(
      makeRequest(`finding_ids=${FINDING_A},not-a-uuid`),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when more than 50 finding_ids are supplied', async () => {
    // 51 fake-but-valid UUIDs.
    const ids = Array.from({ length: 51 }, (_, i) => {
      const tail = i.toString(16).padStart(12, '0');
      return `00000000-0000-4000-8000-${tail}`;
    });
    const res = await GET(
      makeRequest(`finding_ids=${ids.join(',')}`),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/at most 50/);
  });

  it('returns 401 when no auth user is present', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET(
      makeRequest(`finding_ids=${FINDING_A}`),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the audit is owned by a different user', async () => {
    auditMaybeSingleMock.mockResolvedValueOnce({
      data: { ...defaultAudit(), user_id: 'someone-else' },
      error: null,
    });
    const res = await GET(
      makeRequest(`finding_ids=${FINDING_A}`),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(404);
  });

  it('returns 409 when the audit is not completed', async () => {
    auditMaybeSingleMock.mockResolvedValueOnce({
      data: { ...defaultAudit(), status: 'pending' },
      error: null,
    });
    const res = await GET(
      makeRequest(`finding_ids=${FINDING_A}`),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(409);
  });

  it('returns 400 with the offending ids when one finding is not approved', async () => {
    findingsResolveMock.mockResolvedValueOnce({
      data: [
        approvedFinding(FINDING_A, 'rule_a', 1000),
        { ...approvedFinding(FINDING_B, 'rule_b', 2500), status: 'new' },
      ],
      error: null,
    });
    const res = await GET(
      makeRequest(`finding_ids=${FINDING_A},${FINDING_B}`),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      finding_ids: string[];
    };
    expect(body.error).toBe('findings_not_approved');
    expect(body.finding_ids).toEqual([FINDING_B]);
  });

  it('returns 400 with the offending ids when a finding does not belong to the audit', async () => {
    // Only one of the two requested ids is returned by the DB.
    findingsResolveMock.mockResolvedValueOnce({
      data: [approvedFinding(FINDING_A, 'rule_a', 1000)],
      error: null,
    });
    const res = await GET(
      makeRequest(`finding_ids=${FINDING_A},${FINDING_C}`),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      finding_ids: string[];
    };
    expect(body.error).toBe('unknown_finding_ids');
    expect(body.finding_ids).toEqual([FINDING_C]);
  });

  it('renders a PDF response with the expected headers on the happy path', async () => {
    const res = await GET(
      makeRequest(`finding_ids=${FINDING_A},${FINDING_B}`),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const disposition = res.headers.get('content-disposition') ?? '';
    // Filename uses the audit short id (first 8 chars).
    expect(disposition).toContain(
      `carrieraudit-dispute-letter-${AUDIT_ID.slice(0, 8)}.pdf`,
    );
    expect(res.headers.get('cache-control')).toContain('private');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    // We DB-filtered against the requested ids.
    expect(findingsInCalls).toEqual([[FINDING_A, FINDING_B]]);
  });

  it('dedupes repeated finding_ids before issuing the DB filter', async () => {
    const res = await GET(
      makeRequest(`finding_ids=${FINDING_A},${FINDING_A},${FINDING_B}`),
      makeContext(AUDIT_ID),
    );
    expect(res.status).toBe(200);
    expect(findingsInCalls[0]).toEqual([FINDING_A, FINDING_B]);
  });
});
