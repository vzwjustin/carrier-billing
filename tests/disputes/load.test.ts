import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for src/disputes/load.ts — the shared loader for both
 * /api/audits/[id]/findings/[findingId]/dispute.pdf and dispute.eml.
 *
 * loadDisputePacket is the auth + lookup boundary; both surfaces are thin
 * format wrappers around its output. Test the full matrix:
 *   - bad params → 400
 *   - bad token shape → 404
 *   - public token path: rate limit, expired token, audit not found
 *   - authenticated path: 401 missing session, 404 RLS-hidden, 409 not-completed
 *   - finding lookup: not found → 404, wrong audit → 404, DB error → 500
 *   - happy path: returns a kind:'ok' outcome with the packet
 */

interface AuditRow {
  id: string;
  user_id: string;
  status: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  share_token: string | null;
  share_token_expires_at: string | null;
}

interface FindingRow {
  id: string;
  audit_id: string;
  rule_id: string;
  severity: 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number;
  confidence: number;
  affected_line_ids: string[] | null;
  affected_account_ids: string[] | null;
}

const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const FINDING_ID = '22222222-2222-4222-8222-222222222222';
const VALID_TOKEN = 'A'.repeat(32);

const {
  getUserMock,
  serverAuditMaybeSingleMock,
  adminAuditMaybeSingleMock,
  adminFindingMaybeSingleMock,
  consumeRateLimitMock,
  linesResolveMock,
  accountsResolveMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  serverAuditMaybeSingleMock: vi.fn(),
  adminAuditMaybeSingleMock: vi.fn(),
  adminFindingMaybeSingleMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
  linesResolveMock: vi.fn(),
  accountsResolveMock: vi.fn(),
}));

function makeServerAuditChain() {
  return {
    select: () => ({
      eq: () => ({ maybeSingle: serverAuditMaybeSingleMock }),
    }),
  };
}

function makeAdminAuditChain() {
  return {
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: adminAuditMaybeSingleMock }),
      }),
    }),
  };
}

function makeAdminFindingChain() {
  return {
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: adminFindingMaybeSingleMock }),
      }),
    }),
  };
}

function makeLinesChain() {
  const chain = {
    eq: () => chain,
    in: () => chain,
    order: () => linesResolveMock(),
    then: <T>(resolve: (v: { data: unknown[]; error: null }) => T) =>
      linesResolveMock().then(resolve),
  };
  return chain;
}

function makeAccountsChain() {
  const chain = {
    eq: () => chain,
    in: () => chain,
    order: () => accountsResolveMock(),
    then: <T>(resolve: (v: { data: unknown[]; error: null }) => T) =>
      accountsResolveMock().then(resolve),
  };
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: (table: string) => {
      if (table === 'audits') return makeServerAuditChain();
      throw new Error(`unexpected server.from(${table})`);
    },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      if (table === 'audits') return makeAdminAuditChain();
      if (table === 'findings') return makeAdminFindingChain();
      if (table === 'bill_lines') {
        return { select: () => makeLinesChain() };
      }
      if (table === 'bill_accounts') {
        return { select: () => makeAccountsChain() };
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

import { loadDisputePacket } from '@/disputes/load';

function futureShareExpiry(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function makeAudit(over: Partial<AuditRow> = {}): AuditRow {
  const row: AuditRow = {
    id: AUDIT_ID,
    user_id: USER_A_ID,
    status: 'completed',
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    share_token: null,
    share_token_expires_at: null,
    ...over,
  };
  if (row.share_token && row.share_token_expires_at === null) {
    return { ...row, share_token_expires_at: futureShareExpiry() };
  }
  return row;
}

function makeFinding(over: Partial<FindingRow> = {}): FindingRow {
  return {
    id: FINDING_ID,
    audit_id: AUDIT_ID,
    rule_id: 'orphan_insurance',
    severity: 'medium',
    title: 'Test finding',
    description: 'Some description',
    recommended_action: 'Call the carrier',
    estimated_monthly_savings_cents: 1500,
    confidence: 0.85,
    affected_line_ids: null,
    affected_account_ids: null,
    ...over,
  };
}

function makeReq(params: string = ''): Request {
  return new Request(
    `http://localhost/api/audits/${AUDIT_ID}/findings/${FINDING_ID}/dispute.pdf${params}`,
  );
}

beforeEach(() => {
  getUserMock.mockReset();
  serverAuditMaybeSingleMock.mockReset();
  adminAuditMaybeSingleMock.mockReset();
  adminFindingMaybeSingleMock.mockReset();
  consumeRateLimitMock.mockReset();
  linesResolveMock.mockReset();
  accountsResolveMock.mockReset();

  getUserMock.mockResolvedValue({
    data: { user: { id: USER_A_ID } },
    error: null,
  });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    resetAt: new Date().toISOString(),
  });
  serverAuditMaybeSingleMock.mockResolvedValue({
    data: makeAudit(),
    error: null,
  });
  adminFindingMaybeSingleMock.mockResolvedValue({
    data: makeFinding(),
    error: null,
  });
  linesResolveMock.mockResolvedValue({ data: [], error: null });
  accountsResolveMock.mockResolvedValue({ data: [], error: null });
});

describe('loadDisputePacket — param validation', () => {
  it('returns 400 when the audit id is not a uuid', async () => {
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: 'not-a-uuid', findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(400);
  });

  it('returns 400 when the finding id is not a uuid', async () => {
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: 'nope' },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(400);
  });
});

describe('loadDisputePacket — share token shape', () => {
  it('returns 404 when a token is provided but does not match the 32-char base64url shape', async () => {
    const outcome = await loadDisputePacket(
      makeReq('?token=too-short'),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(404);
  });
});

describe('loadDisputePacket — authenticated path', () => {
  it('returns 401 when there is no session', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(401);
  });

  it('returns 404 when the audit row is RLS-hidden (data:null)', async () => {
    serverAuditMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(404);
  });

  it("returns 404 when the audit belongs to a different user (defense in depth past RLS)", async () => {
    serverAuditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ user_id: 'someone-else' }),
      error: null,
    });
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(404);
  });

  it('returns 500 with a generic message when the audit lookup errors', async () => {
    serverAuditMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection refused' },
    });
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(500);
    const body = await outcome.response.text();
    expect(body).not.toContain('connection refused');
  });

  it('returns 409 audit_not_completed when status is not completed', async () => {
    serverAuditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ status: 'analyzing' }),
      error: null,
    });
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(409);
  });

  it('uses a per-user rate-limit key with surface in the key', async () => {
    await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'eml',
    );
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as { key: string };
    expect(call.key).toBe(`dispute-eml-auth:${USER_A_ID}`);
  });

  it('returns 429 when authenticated rate limit is exhausted', async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      resetAt: new Date().toISOString(),
    });
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(429);
  });
});

describe('loadDisputePacket — share token path', () => {
  it('returns the packet via the admin client when token matches', async () => {
    adminAuditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ share_token: VALID_TOKEN }),
      error: null,
    });
    const outcome = await loadDisputePacket(
      makeReq(`?token=${VALID_TOKEN}`),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('ok');
  });

  it('returns 404 when share token has NULL expiry (legacy row without TTL)', async () => {
    adminAuditMaybeSingleMock.mockResolvedValueOnce({
      data: {
        ...makeAudit({ share_token: VALID_TOKEN }),
        share_token_expires_at: null,
      },
      error: null,
    });
    const outcome = await loadDisputePacket(
      makeReq(`?token=${VALID_TOKEN}`),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(404);
  });

  it('returns 404 when the public token is past its expiration', async () => {
    adminAuditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({
        share_token: VALID_TOKEN,
        share_token_expires_at: '2020-01-01T00:00:00Z',
      }),
      error: null,
    });
    const outcome = await loadDisputePacket(
      makeReq(`?token=${VALID_TOKEN}`),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(404);
  });

  it('returns 404 when share token does not match (admin lookup returns null)', async () => {
    adminAuditMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    const outcome = await loadDisputePacket(
      makeReq(`?token=${VALID_TOKEN}`),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(404);
  });

  it('uses the hashed token in the rate-limit key (never raw)', async () => {
    adminAuditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ share_token: VALID_TOKEN }),
      error: null,
    });
    await loadDisputePacket(
      makeReq(`?token=${VALID_TOKEN}`),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as { key: string };
    expect(call.key).toBe(`dispute-pdf-public:hashed-AAAA`);
    expect(call.key).not.toContain(VALID_TOKEN);
  });

  it('public-path rate limit is 10/5min (stricter than authed 20)', async () => {
    adminAuditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ share_token: VALID_TOKEN }),
      error: null,
    });
    await loadDisputePacket(
      makeReq(`?token=${VALID_TOKEN}`),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as {
      limit: number;
      windowSeconds: number;
    };
    expect(call.limit).toBe(10);
    expect(call.windowSeconds).toBe(300);
  });
});

describe('loadDisputePacket — finding lookup', () => {
  it('returns 404 when the finding is not found', async () => {
    adminFindingMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(404);
  });

  it('returns 500 when the finding lookup errors', async () => {
    adminFindingMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'db down' },
    });
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(500);
  });
});

describe('loadDisputePacket — happy path', () => {
  it('returns a kind:"ok" outcome with the assembled packet', async () => {
    const outcome = await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.packet).toBeDefined();
    expect(outcome.packet.ruleId).toBe('orphan_insurance');
  });

  it('skips lines/accounts lookups when finding has no affected ids', async () => {
    await loadDisputePacket(
      makeReq(),
      { id: AUDIT_ID, findingId: FINDING_ID },
      'pdf',
    );
    expect(linesResolveMock).not.toHaveBeenCalled();
    expect(accountsResolveMock).not.toHaveBeenCalled();
  });
});
