import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryError = { message: string };
type QueryResult<T> = {
  data: T | null;
  count?: number | null;
  error: QueryError | null;
};

type AuditRow = {
  id: string;
  created_at: string;
  original_filename?: string;
  carrier?: string | null;
  status?: string;
  estimated_annual_savings_cents?: number | null;
  total_charges_cents?: number | null;
  high_severity_count?: number | null;
};

type BillComparisonRow = {
  id: string;
  current_audit_id: string;
  previous_audit_id: string;
  net_change_cents: number;
  percent_change_bps: number | null;
  disputable_cents: number;
  unexplained_cents: number;
  created_at: string;
};

type ContractRow = {
  id: string;
  original_filename: string;
  carrier: string | null;
  ban_last4: string | null;
  expiration_date: string | null;
};

type BillLineRow = {
  cost_center: string | null;
  plan_base_cents: number | null;
};

type FindingRow = {
  audit_id: string;
  severity: string;
};

const getUserMock = vi.fn(async () => ({
  data: { user: { id: 'user-uuid-1', email: 'user@example.com' } },
  error: null,
}));

let auditResults: Array<QueryResult<AuditRow[]>>;
let billComparisonResult: QueryResult<BillComparisonRow | null>;
let contractResult: QueryResult<ContractRow[]>;
let billLineResult: QueryResult<BillLineRow[]>;
let findingResult: QueryResult<FindingRow[]>;

function ok<T>(data: T, count?: number | null): QueryResult<T> {
  return { data, count, error: null };
}

function fail<T>(message = 'database unavailable'): QueryResult<T> {
  return { data: null, error: { message } };
}

function nextAuditResult(): QueryResult<AuditRow[]> {
  const result = auditResults.shift();
  if (!result) throw new Error('unexpected audits query');
  return result;
}

function makeBuilder<T>(result: QueryResult<T>) {
  const builder = {
    eq: () => builder,
    in: () => builder,
    limit: () => builder,
    not: () => builder,
    order: () => builder,
    returns: async () => result,
    maybeSingle: async () => result,
    then: (resolve: (value: QueryResult<T>) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function makeSupabaseClient() {
  return {
    auth: { getUser: getUserMock },
    from: (table: string) => {
      if (table === 'audits') {
        return {
          select: () => makeBuilder(nextAuditResult()),
        };
      }
      if (table === 'bill_comparisons') {
        return {
          select: () => makeBuilder(billComparisonResult),
        };
      }
      if (table === 'contracts') {
        return {
          select: () => makeBuilder(contractResult),
        };
      }
      if (table === 'bill_lines') {
        return {
          select: () => makeBuilder(billLineResult),
        };
      }
      if (table === 'findings') {
        return {
          select: () => makeBuilder(findingResult),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

vi.mock('@/components/dashboard/onboarding-checklist', () => ({
  OnboardingChecklist: ({ userId }: { userId: string }) => (
    <section data-user-id={userId}>Onboarding checklist</section>
  ),
}));

vi.mock('@/components/dashboard/findings-over-time-chart', () => ({
  FindingsOverTimeChart: () => <section>Findings chart</section>,
}));

vi.mock('@/components/dashboard/spend-by-carrier-chart', () => ({
  SpendByCarrierChart: () => <section>Spend chart</section>,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeSupabaseClient(),
}));

const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');

beforeEach(() => {
  getUserMock.mockClear();
  auditResults = [
    ok<AuditRow[]>([], 0),
    ok<AuditRow[]>([]),
    ok<AuditRow[]>([]),
    ok<AuditRow[]>([]),
  ];
  billComparisonResult = ok<BillComparisonRow | null>(null);
  contractResult = ok<ContractRow[]>([]);
  billLineResult = ok<BillLineRow[]>([]);
  findingResult = ok<FindingRow[]>([]);
});

describe('DashboardPage load failures', () => {
  it('surfaces primary audit query failures instead of rendering empty metrics', async () => {
    auditResults = [
      fail<AuditRow[]>('audits count failed'),
      ok<AuditRow[]>([]),
      ok<AuditRow[]>([]),
      ok<AuditRow[]>([]),
    ];

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain('Dashboard unavailable');
    expect(html).toContain('couldn&#x27;t load your dashboard metrics');
    expect(html).not.toContain('Onboarding checklist');
    expect(html).not.toContain('Audits run');
  });

  it('keeps primary dashboard content visible and marks secondary sections unavailable', async () => {
    auditResults = [
      ok<AuditRow[]>([], 1),
      ok<AuditRow[]>([
        {
          id: 'audit-1',
          created_at: '2026-05-01T12:00:00Z',
          original_filename: 'may-bill.pdf',
          carrier: 'verizon',
          status: 'completed',
          estimated_annual_savings_cents: 120000,
        },
      ]),
      ok<AuditRow[]>([
        {
          id: 'audit-1',
          created_at: '2026-05-01T12:00:00Z',
          carrier: 'verizon',
          status: 'completed',
          estimated_annual_savings_cents: 120000,
          total_charges_cents: 450000,
          high_severity_count: 2,
        },
      ]),
      ok<AuditRow[]>([]),
    ];
    contractResult = fail<ContractRow[]>('contracts failed');

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain('Audits run');
    expect(html).toContain('Lifetime savings identified');
    expect(html).toContain('Upcoming renewals unavailable');
    expect(html).toContain('couldn&#x27;t load contract renewal dates');
    expect(html).not.toContain('Dashboard unavailable');
  });
});
