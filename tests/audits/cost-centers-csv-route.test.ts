import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for GET /api/audits/[id]/cost-centers.csv.
 *
 * Mirror of findings-csv-route.test.ts but for the cost-center roll-up.
 * Coverage:
 *   - 400 invalid uuid
 *   - 404 bad token shape
 *   - 401 missing session on authed path
 *   - 404 RLS-hidden / wrong-owner audit
 *   - 409 when audit is not completed
 *   - 200 happy path: CSV body + correct headers + filename
 *   - rate-limit keys are scoped correctly (per-user authed, hashed-token public)
 */

const USER_ID = '33333333-3333-4333-8333-333333333333';
const AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const VALID_TOKEN = 'A'.repeat(32);

const {
  getUserMock,
  serverMaybeSingleMock,
  adminAuditMaybeSingleMock,
  linesResolveMock,
  consumeRateLimitMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  serverMaybeSingleMock: vi.fn(),
  adminAuditMaybeSingleMock: vi.fn(),
  linesResolveMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: serverMaybeSingleMock }),
      }),
    }),
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      if (table === 'audits') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: adminAuditMaybeSingleMock }),
            }),
          }),
        };
      }
      if (table === 'bill_lines') {
        return {
          select: () => ({
            eq: () => linesResolveMock(),
          }),
        };
      }
      throw new Error(`unexpected admin.from(${table})`);
    },
  }),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: consumeRateLimitMock,
  rateLimitedResponse: () => new Response('rate-limited', { status: 429 }),
}));

vi.mock('@/lib/analytics/hash', () => ({
  hashTokenForAnalytics: (t: string) => `hashed-${t.slice(0, 4)}`,
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

import { GET } from '@/app/api/audits/[id]/cost-centers.csv/route';

function makeContext(id: string = AUDIT_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeAudit(over: Record<string, unknown> = {}) {
  return {
    id: AUDIT_ID,
    user_id: USER_ID,
    status: 'completed',
    share_token: null,
    share_token_expires_at: null,
    ...over,
  };
}

beforeEach(() => {
  getUserMock.mockReset();
  serverMaybeSingleMock.mockReset();
  adminAuditMaybeSingleMock.mockReset();
  linesResolveMock.mockReset();
  consumeRateLimitMock.mockReset();

  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID } },
    error: null,
  });
  serverMaybeSingleMock.mockResolvedValue({ data: makeAudit(), error: null });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    resetAt: new Date().toISOString(),
  });
  linesResolveMock.mockResolvedValue({
    data: [
      { cost_center: 'Engineering', plan_base_cents: 6500 },
      { cost_center: 'Engineering', plan_base_cents: 6500 },
      { cost_center: 'Sales', plan_base_cents: 5000 },
      { cost_center: null, plan_base_cents: 4000 },
    ],
    error: null,
  });
});

describe('GET cost-centers.csv — param + token validation', () => {
  it('returns 400 when id is not a uuid', async () => {
    const res = await GET(
      new Request('http://localhost/api/audits/bad/cost-centers.csv'),
      makeContext('not-a-uuid'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when token is provided in a malformed shape', async () => {
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv?token=short`),
      makeContext(),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET cost-centers.csv — authenticated path', () => {
  it('returns 401 when no session', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv`),
      makeContext(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when audit row is RLS-hidden', async () => {
    serverMaybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv`),
      makeContext(),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when audit belongs to a different user', async () => {
    serverMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ user_id: 'someone-else' }),
      error: null,
    });
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv`),
      makeContext(),
    );
    expect(res.status).toBe(404);
  });

  it('returns 500 when the audit lookup errors', async () => {
    serverMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection refused' },
    });
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv`),
      makeContext(),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('connection refused');
  });

  it('returns 409 audit_not_completed when status is not completed', async () => {
    serverMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ status: 'analyzing' }),
      error: null,
    });
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv`),
      makeContext(),
    );
    expect(res.status).toBe(409);
  });

  it('uses a per-userId rate-limit key', async () => {
    await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv`),
      makeContext(),
    );
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as {
      key: string;
      limit: number;
    };
    expect(call.key).toBe(`cost-centers-csv-auth:${USER_ID}`);
    expect(call.limit).toBe(30);
  });
});

describe('GET cost-centers.csv — public-token path', () => {
  it('uses the hashed token in the rate-limit key (never raw)', async () => {
    adminAuditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ share_token: VALID_TOKEN }),
      error: null,
    });
    await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv?token=${VALID_TOKEN}`),
      makeContext(),
    );
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as {
      key: string;
      limit: number;
    };
    expect(call.key).toBe(`cost-centers-csv-public:hashed-AAAA`);
    expect(call.key).not.toContain(VALID_TOKEN);
    // Public limit is stricter than authed (10 vs 30).
    expect(call.limit).toBe(10);
  });

  it('returns 404 when token does not match', async () => {
    adminAuditMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv?token=${VALID_TOKEN}`),
      makeContext(),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the share token has expired', async () => {
    adminAuditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({
        share_token: VALID_TOKEN,
        share_token_expires_at: '2020-01-01T00:00:00Z',
      }),
      error: null,
    });
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv?token=${VALID_TOKEN}`),
      makeContext(),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET cost-centers.csv — happy path', () => {
  it('returns CSV with the right MIME, filename, and headers', async () => {
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv`),
      makeContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain(`carrieraudit-cost-centers-${AUDIT_ID.slice(0, 8)}.csv`);
    // toCsv emits private/max-age/must-revalidate; what matters is that the
    // CDN can't cache a per-customer financial export.
    expect(res.headers.get('Cache-Control')).toContain('private');
    expect(res.headers.get('Cache-Control')).toContain('max-age=0');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('CSV body has the documented header columns + aggregated rows', async () => {
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv`),
      makeContext(),
    );
    const body = await res.text();
    // toCsv joins with CRLF — split on either to normalize.
    const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
    const headerRow = lines[0];
    const dataRows = lines.slice(1);
    expect(headerRow).toBe('cost_center,line_count,monthly_total_dollars,annual_total_dollars');
    // 3 unique buckets: Engineering, Sales, (unassigned)
    expect(dataRows.length).toBe(3);
    // Engineering row: 2 lines × $65 = $130/mo, $1560/yr.
    const eng = dataRows.find((r) => r.startsWith('Engineering'));
    expect(eng).toContain(',2,'); // line_count = 2
    expect(eng).toContain(',130.00,'); // monthly
    expect(eng).toContain(',1560.00'); // annual
  });

  it('returns 500 with a generic error when the bill_lines lookup fails', async () => {
    linesResolveMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'db down' },
    });
    const res = await GET(
      new Request(`http://localhost/api/audits/${AUDIT_ID}/cost-centers.csv`),
      makeContext(),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('db down');
  });
});
