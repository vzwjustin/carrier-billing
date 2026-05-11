import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Types ------------------------------------------------------------------

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

type AuditRow = {
  user_id: string;
  status: string;
  carrier: string | null;
  line_count: number | null;
  total_charges_cents: number | null;
  failure_reason: string | null;
  account_count: number | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
};

type MaybeSingleResult =
  | { data: AuditRow; error: null }
  | { data: null; error: null }
  | { data: null; error: { message: string } };

// --- Mocks ------------------------------------------------------------------
// Must be declared before importing the route under test.

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const maybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();

const eqMock = vi.fn(() => ({
  maybeSingle: () => maybeSingleMock(),
}));

const selectMock = vi.fn((_cols: string) => ({
  eq: (_col: string, _val: string) => eqMock(),
}));

const fromMock = vi.fn((_table: string) => ({
  select: (cols: string) => selectMock(cols),
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
  },
}));

// Import after mocks are registered.
import { GET } from '@/app/api/audits/[id]/status/route';

const VALID_AUDIT_ID = '11111111-1111-4111-8111-111111111111';

function makeContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): Request {
  return new Request(`http://localhost/api/audits/${VALID_AUDIT_ID}/status`);
}

function emptyAudit(overrides: Partial<AuditRow>): AuditRow {
  return {
    user_id: 'user-uuid-1',
    status: 'pending',
    carrier: null,
    line_count: null,
    total_charges_cents: null,
    failure_reason: null,
    account_count: null,
    billing_period_start: null,
    billing_period_end: null,
    estimated_monthly_savings_cents: null,
    estimated_annual_savings_cents: null,
    finding_count: null,
    high_severity_count: null,
    ...overrides,
  };
}

beforeEach(() => {
  getUserMock.mockReset();
  maybeSingleMock.mockReset();
  eqMock.mockClear();
  selectMock.mockClear();
  fromMock.mockClear();

  getUserMock.mockResolvedValue({
    data: { user: { id: 'user-uuid-1', email: 'test@example.com' } },
    error: null,
  });
});

describe('GET /api/audits/[id]/status', () => {
  it('returns 401 when there is no authenticated user', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(401);
  });

  it('returns 400 when the audit id is not a uuid', async () => {
    const res = await GET(makeRequest(), makeContext('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the audit row is not found', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(404);
  });

  it('maps a completed audit to progress=100 and includes savings + counts', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: emptyAudit({
        status: 'completed',
        carrier: 'verizon',
        line_count: 42,
        account_count: 3,
        total_charges_cents: 1234567,
        billing_period_start: '2026-04-01',
        billing_period_end: '2026-04-30',
        estimated_monthly_savings_cents: 12345,
        estimated_annual_savings_cents: 12345 * 12,
        finding_count: 5,
        high_severity_count: 2,
      }),
      error: null,
    });

    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json['status']).toBe('completed');
    expect(json['progress']).toBe(100);
    expect(json['currentStep']).toBe('Done');
    expect(json['finding_count']).toBe(5);
    expect(json['high_severity_count']).toBe(2);
    expect(json['estimated_monthly_savings_cents']).toBe(12345);
    expect(json['estimated_annual_savings_cents']).toBe(12345 * 12);
    expect(json['carrier']).toBe('verizon');
    expect(json['line_count']).toBe(42);
    expect(json['account_count']).toBe(3);
    expect(json['total_charges_cents']).toBe(1234567);
  });

  it('returns failure_reason and progress=100 for failed status', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: emptyAudit({
        status: 'failed',
        failure_reason: 'extraction:llm-extract: schema validation failed',
      }),
      error: null,
    });

    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json['status']).toBe('failed');
    expect(json['progress']).toBe(100);
    expect(json['currentStep']).toBe('Failed');
    expect(json['failure_reason']).toBe(
      'extraction:llm-extract: schema validation failed',
    );
  });

  it('uses the right currentStep wording for in-flight states', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: emptyAudit({ status: 'extracting' }),
      error: null,
    });
    let res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    let json = (await res.json()) as Record<string, unknown>;
    expect(json['progress']).toBe(25);
    expect(json['currentStep']).toBe('Reading PDF and extracting bill data');

    maybeSingleMock.mockResolvedValueOnce({
      data: emptyAudit({ status: 'analyzing' }),
      error: null,
    });
    res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    json = (await res.json()) as Record<string, unknown>;
    expect(json['progress']).toBe(70);
    expect(json['currentStep']).toBe('Running audit rules');

    maybeSingleMock.mockResolvedValueOnce({
      data: emptyAudit({ status: 'pending' }),
      error: null,
    });
    res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    json = (await res.json()) as Record<string, unknown>;
    expect(json['progress']).toBe(5);
    expect(json['currentStep']).toBe('Queued');
  });
});
