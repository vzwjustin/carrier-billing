/**
 * Cross-cutting RLS multi-tenant isolation tests.
 *
 * These exercise the per-route auth flow with a Supabase server-client mock
 * that simulates RLS: when the session user is not the owner of the audit,
 * `from('audits').select().eq('id', X).maybeSingle()` resolves to
 * `{ data: null, error: null }` exactly as a real RLS-scoped query would.
 *
 * We verify each of the four authenticated audit routes returns 404 (NOT
 * 403/500/leaking the row) when user A queries an audit owned by user B:
 *   - GET    /api/audits/[id]/status
 *   - POST   /api/audits/[id]/share
 *   - POST   /api/audits/[id]/start
 *   - GET    /api/audits/[id]/report.pdf
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Two-tenant fixture: audit-a is owned by user-a, audit-b is owned by user-b.
// The mock supabase server client honors the *currently signed-in user* and
// only returns audit rows that user owns. This is the test-time analog of RLS.
// ---------------------------------------------------------------------------

interface FakeAuditRow {
  id: string;
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
  storage_path: string;
  share_token: string | null;
  completed_at: string | null;
}

const AUDIT_A_ID = '11111111-1111-4111-8111-111111111111';
const AUDIT_B_ID = '22222222-2222-4222-8222-222222222222';
const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const AUDITS: Record<string, FakeAuditRow> = {
  [AUDIT_A_ID]: {
    id: AUDIT_A_ID,
    user_id: USER_A_ID,
    status: 'completed',
    carrier: 'verizon',
    line_count: 5,
    total_charges_cents: 50000,
    failure_reason: null,
    account_count: 1,
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    estimated_monthly_savings_cents: 0,
    estimated_annual_savings_cents: 0,
    finding_count: 0,
    high_severity_count: 0,
    storage_path: `${USER_A_ID}/${AUDIT_A_ID}/bill.pdf`,
    share_token: null,
    completed_at: '2026-05-01T00:00:00Z',
  },
  [AUDIT_B_ID]: {
    id: AUDIT_B_ID,
    user_id: USER_B_ID,
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
    storage_path: `${USER_B_ID}/${AUDIT_B_ID}/bill.pdf`,
    share_token: null,
    completed_at: null,
  },
};

// The currently "signed-in" user. Tests flip this between requests.
let CURRENT_USER_ID: string | null = USER_A_ID;

// ---------------------------------------------------------------------------
// Mocks. Declared before importing routes under test.
// ---------------------------------------------------------------------------

type MaybeSingleResult =
  | { data: FakeAuditRow; error: null }
  | { data: null; error: null }
  | { data: null; error: { message: string } };

// RLS-aware lookup: only return the audit if the current user owns it.
function rlsScopedLookup(auditId: string): MaybeSingleResult {
  const row = AUDITS[auditId];
  if (!row) return { data: null, error: null };
  if (row.user_id !== CURRENT_USER_ID) {
    // RLS hides the row; PostgREST returns null/null for maybeSingle().
    return { data: null, error: null };
  }
  return { data: row, error: null };
}

// Track the last audit id that .eq('id', x) was called with so maybeSingle()
// can use it. Each call to .from(...).select(...).eq(...) creates a fresh
// builder via this closure — this matches PostgREST's chained API surface.
function makeServerSelectBuilder() {
  let pendingAuditId: string | null = null;
  return {
    eq(_col: string, val: string) {
      pendingAuditId = val;
      return this;
    },
    maybeSingle: async (): Promise<MaybeSingleResult> => {
      if (!pendingAuditId) return { data: null, error: null };
      return rlsScopedLookup(pendingAuditId);
    },
  };
}

const updateEqMock = vi.fn(async () => ({ data: null, error: null }));

const fromMock = vi.fn((_table: string) => ({
  select: (_cols: string) => makeServerSelectBuilder(),
  update: (_row: Record<string, unknown>) => ({
    eq: (_col: string, _val: string) => updateEqMock(),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: {
          user: CURRENT_USER_ID ? { id: CURRENT_USER_ID, email: 'x@example.com' } : null,
        },
        error: null,
      }),
    },
    from: fromMock,
  }),
}));

// Admin-client is used after route-level ownership checks for trusted writes
// and report child-row reads. Cross-tenant tests still assert the owner-scoped
// read happens before any trusted write.
const adminFromCalled = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (_t: string) => {
      adminFromCalled(_t);
      return {
        select: (_cols: string) => ({
          eq: (_col: string, _val: string) => ({
            eq: (_col2: string, _val2: string) => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        update: (_row: Record<string, unknown>) => ({
          eq: (_col: string, _val: string) => updateEqMock(),
        }),
      };
    },
    storage: {
      from: () => ({
        download: async () => ({
          data: null,
          error: { message: 'not found' },
        }),
        upload: async () => ({ data: null, error: null }),
      }),
    },
  }),
}));

// Inngest send is a side-effect we don't want during these tests.
// Use vi.hoisted so the mock variable is initialized before vi.mock factory runs.
const { inngestSendMock } = vi.hoisted(() => ({
  inngestSendMock: vi.fn(async () => ({ ids: ['evt_x'] })),
}));
vi.mock('@/inngest/client', () => ({
  inngest: { send: inngestSendMock },
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    NEXT_PUBLIC_APP_URL: 'https://app.carrieraudit.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-placeholder',
  },
}));

// Analytics: stub trackServer so tests don't hit PostHog.
vi.mock('@/lib/analytics/events', () => ({
  trackServer: async () => undefined,
  trackClient: () => undefined,
}));

// ---------------------------------------------------------------------------
// Route imports must come after the mocks above.
// ---------------------------------------------------------------------------
import { GET as GET_status } from '@/app/api/audits/[id]/status/route';
import { POST as POST_share } from '@/app/api/audits/[id]/share/route';
import { POST as POST_start } from '@/app/api/audits/[id]/start/route';
import { GET as GET_report } from '@/app/api/audits/[id]/report.pdf/route';

function makeContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  CURRENT_USER_ID = USER_A_ID;
  fromMock.mockClear();
  updateEqMock.mockClear();
  adminFromCalled.mockClear();
  inngestSendMock.mockClear();
});

describe('RLS multi-tenant isolation across audit routes', () => {
  // Sanity check: when the owner queries their own audit, the route succeeds.
  // Without this, a buggy mock could make the negative tests pass trivially.
  describe('positive control (owner sees their own audit)', () => {
    it('GET /api/audits/[id]/status returns 200 for the owner', async () => {
      CURRENT_USER_ID = USER_A_ID;
      const res = await GET_status(
        new Request(`http://localhost/api/audits/${AUDIT_A_ID}/status`),
        makeContext(AUDIT_A_ID),
      );
      expect(res.status).toBe(200);
    });

    it('POST /api/audits/[id]/share returns 200 for the owner', async () => {
      CURRENT_USER_ID = USER_A_ID;
      const res = await POST_share(
        new Request(`http://localhost/api/audits/${AUDIT_A_ID}/share`, {
          method: 'POST',
        }),
        makeContext(AUDIT_A_ID),
      );
      expect(res.status).toBe(200);
    });
  });

  // ---- The four cross-tenant negative cases ---------------------------------
  describe("user A querying user B's audit", () => {
    beforeEach(() => {
      CURRENT_USER_ID = USER_A_ID;
    });

    it("GET /api/audits/[id]/status returns 404 (RLS hides B's audit)", async () => {
      const res = await GET_status(
        new Request(`http://localhost/api/audits/${AUDIT_B_ID}/status`),
        makeContext(AUDIT_B_ID),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('Audit not found.');
    });

    it("POST /api/audits/[id]/share returns 404 (RLS hides B's audit) and never updates", async () => {
      const res = await POST_share(
        new Request(`http://localhost/api/audits/${AUDIT_B_ID}/share`, {
          method: 'POST',
        }),
        makeContext(AUDIT_B_ID),
      );
      expect(res.status).toBe(404);
      // Critically, no update was issued — the row was never even visible.
      expect(updateEqMock).not.toHaveBeenCalled();
    });

    it("POST /api/audits/[id]/start returns 404 (RLS hides B's audit) and never enqueues", async () => {
      const res = await POST_start(
        new Request(`http://localhost/api/audits/${AUDIT_B_ID}/start`, {
          method: 'POST',
        }),
        makeContext(AUDIT_B_ID),
      );
      expect(res.status).toBe(404);
      expect(inngestSendMock).not.toHaveBeenCalled();
    });

    it("GET /api/audits/[id]/report.pdf returns 404 (RLS hides B's audit)", async () => {
      const res = await GET_report(
        new Request(`http://localhost/api/audits/${AUDIT_B_ID}/report.pdf`),
        makeContext(AUDIT_B_ID),
      );
      expect(res.status).toBe(404);
      // The auth path must NOT fall through to admin client storage reads.
      // (Admin lookups are reserved for the share-token branch.)
      expect(adminFromCalled).not.toHaveBeenCalled();
    });
  });

  // ---- Symmetric: user B querying user A's audit ---------------------------
  describe("symmetric isolation: user B querying user A's audit", () => {
    beforeEach(() => {
      CURRENT_USER_ID = USER_B_ID;
    });

    it("GET /api/audits/[id]/status returns 404 for user B against A's audit", async () => {
      const res = await GET_status(
        new Request(`http://localhost/api/audits/${AUDIT_A_ID}/status`),
        makeContext(AUDIT_A_ID),
      );
      expect(res.status).toBe(404);
    });

    it("POST /api/audits/[id]/share returns 404 for user B against A's audit", async () => {
      const res = await POST_share(
        new Request(`http://localhost/api/audits/${AUDIT_A_ID}/share`, {
          method: 'POST',
        }),
        makeContext(AUDIT_A_ID),
      );
      expect(res.status).toBe(404);
    });
  });
});
