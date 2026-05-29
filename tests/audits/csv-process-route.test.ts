import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/audits/csv/[id]/process — focused on completion
 * correctness: status-guarded mark-completed must not return ok:true on
 * failure, and successful runs must dispatch audit.completed side effects.
 */

const TEST_AUDIT_ID = '44444444-4444-4444-8444-444444444444';
const TEST_USER_ID = '55555555-5555-4555-8555-555555555555';

const SAMPLE_BILL = {
  carrier: 'verizon' as const,
  billing_period_start: '2026-01-01',
  billing_period_end: '2026-01-31',
  total_charges_cents: 4_500,
  accounts: [
    {
      account_number_last4: '7890',
      label: null,
      total_charges_cents: 4_500,
      taxes_fees_cents: 0,
      lines: [
        {
          mdn_last4: '1111',
          user_label: 'Alice',
          device: null,
          plan_name: 'Business Pro',
          plan_base_cents: 4_500,
          data_used_gb: 1,
          voice_used_min: null,
          sms_used_count: null,
          is_suspended: false,
          features: [],
          credits: [],
          dpp_installments: [],
        },
      ],
      features: [],
      credits: [],
    },
  ],
};

const {
  getUserMock,
  consumeRateLimitMock,
  gateMock,
  parseCsvToBillMock,
  runRulesMock,
  loadContractsMock,
  dispatchCompletedMock,
  auditsFetchMock,
  markAnalyzingMock,
  markCompletedMock,
  storageDownloadMock,
  tableDeleteMock,
  tableInsertMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
  gateMock: vi.fn(),
  parseCsvToBillMock: vi.fn(),
  runRulesMock: vi.fn(),
  loadContractsMock: vi.fn(),
  dispatchCompletedMock: vi.fn(),
  auditsFetchMock: vi.fn(),
  markAnalyzingMock: vi.fn(),
  markCompletedMock: vi.fn(),
  storageDownloadMock: vi.fn(),
  tableDeleteMock: vi.fn(),
  tableInsertMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      if (table === 'audits') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => auditsFetchMock(),
            }),
          }),
          update: (row: Record<string, unknown>) => {
            const filters: Array<[string, unknown]> = [];
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.push([column, value]);
                return builder;
              },
              select: (_cols: string) => {
                const statusFilter = filters.find(([c]) => c === 'status');
                if (statusFilter?.[1] === 'pending') {
                  return markAnalyzingMock();
                }
                if (statusFilter?.[1] === 'analyzing') {
                  return markCompletedMock();
                }
                return Promise.resolve({ data: [], error: null });
              },
              in: () => builder,
              then: (
                resolve: (value: { error: null }) => unknown,
                reject?: (reason: unknown) => unknown,
              ) => Promise.resolve({ error: null }).then(resolve, reject),
            };
            void row;
            return builder;
          },
        };
      }
      return {
        delete: () => ({
          eq: async () => tableDeleteMock(table),
        }),
        insert: async (rows: unknown) => tableInsertMock(table, rows),
      };
    },
    storage: {
      from: () => ({
        download: () => storageDownloadMock(),
      }),
    },
    rpc: async () => ({ data: true, error: null }),
  }),
}));

vi.mock('@/lib/access/gate', () => ({
  assertCanRunAudit: gateMock,
}));

vi.mock('@/lib/access/decrement', () => ({
  consumeAuditCreditForAudit: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: consumeRateLimitMock,
  rateLimitedResponse: () => new Response('rate-limited', { status: 429 }),
}));

vi.mock('@/extraction/csv/parse', () => ({
  parseCsvToBill: (...args: unknown[]) => parseCsvToBillMock(...args),
}));

vi.mock('@/rules/runner', () => ({
  runRules: (...args: unknown[]) => runRulesMock(...args),
}));

vi.mock('@/lib/audits/load-parsed-contracts', () => ({
  loadParsedContractsForUser: (...args: unknown[]) => loadContractsMock(...args),
}));

vi.mock('@/lib/audits/completed-side-effects', () => ({
  dispatchAuditCompletedSideEffects: (...args: unknown[]) =>
    dispatchCompletedMock(...args),
}));

vi.mock('@/lib/audit-trail/log', () => ({
  logTrailEvent: vi.fn(async () => undefined),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

import { POST } from '@/app/api/audits/csv/[id]/process/route';

function makeContext() {
  return { params: Promise.resolve({ id: TEST_AUDIT_ID }) };
}

function makeRequest() {
  return new Request(`http://localhost/api/audits/csv/${TEST_AUDIT_ID}/process`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mapping: { mdn_last4: 'Wireless Number', plan_name: 'Plan' },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  getUserMock.mockResolvedValue({
    data: { user: { id: TEST_USER_ID, email: 'user@example.com' } },
    error: null,
  });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    remaining: 29,
    resetAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  gateMock.mockResolvedValue({ ok: true, reason: 'subscription' });
  auditsFetchMock.mockResolvedValue({
    data: {
      id: TEST_AUDIT_ID,
      user_id: TEST_USER_ID,
      status: 'pending',
      storage_path: `${TEST_USER_ID}/${TEST_AUDIT_ID}/bill.csv`,
      source_format: 'csv',
    },
    error: null,
  });
  storageDownloadMock.mockResolvedValue({
    data: { text: async () => 'mdn,plan\n1111,Pro\n' },
    error: null,
  });
  parseCsvToBillMock.mockReturnValue({ ok: true, bill: SAMPLE_BILL });
  markAnalyzingMock.mockResolvedValue({ data: [{ id: TEST_AUDIT_ID }], error: null });
  markCompletedMock.mockResolvedValue({ data: [{ id: TEST_AUDIT_ID }], error: null });
  tableDeleteMock.mockResolvedValue({ error: null });
  tableInsertMock.mockResolvedValue({ error: null });
  runRulesMock.mockResolvedValue({ findings: [], errors: [] });
  loadContractsMock.mockResolvedValue([]);
  dispatchCompletedMock.mockResolvedValue(undefined);
});

describe('POST /api/audits/csv/[id]/process', () => {
  it('returns 500 when mark-completed affects zero rows', async () => {
    markCompletedMock.mockResolvedValue({ data: [], error: null });

    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; ok?: boolean };
    expect(body.error).toMatch(/finalize/i);
    expect(body.ok).toBeUndefined();
    expect(dispatchCompletedMock).not.toHaveBeenCalled();
  });

  it('dispatches completion side effects on happy path', async () => {
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);

    expect(loadContractsMock).toHaveBeenCalledWith(TEST_USER_ID);
    expect(runRulesMock).toHaveBeenCalledTimes(1);
    const rulesCtx = runRulesMock.mock.calls[0]?.[0] as { contracts?: unknown[] };
    expect(rulesCtx.contracts).toEqual([]);

    expect(dispatchCompletedMock).toHaveBeenCalledTimes(1);
    expect(dispatchCompletedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auditId: TEST_AUDIT_ID,
        userId: TEST_USER_ID,
        carrier: 'verizon',
      }),
    );
  });
});
