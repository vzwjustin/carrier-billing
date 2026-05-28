import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/autopsy/drivers/[driverId]/escalate.
 *
 * This route converts a Bill Increase Autopsy change driver into a full
 * finding. It's high-leverage because the finding's
 * estimated_monthly_savings_cents feeds the audit's headline rollup
 * (annualized × 12 by mark-completed).
 *
 * Coverage:
 *   - 400 invalid uuid
 *   - 401 missing session
 *   - 404 RLS-hidden / wrong-owner via the bill_comparisons join
 *   - 429 per-user rate-limit
 *   - 200 idempotent — alreadyEscalated:true when driver carries an
 *     escalated_finding_id (no new finding insert)
 *   - 200 happy path: severity derivation (high when disputable, medium
 *     otherwise), savings claim only when disputable + bill went UP,
 *     rule_id="autopsy_escalated_<category>", driver stamped, audit
 *     counts bumped, finding.created event fired
 *   - 500 + finding rollback when driver stamping fails
 *   - finding.created send failure does NOT fail the response
 */

const USER_ID = '33333333-3333-4333-8333-333333333333';
const DRIVER_ID = '11111111-1111-4111-8111-111111111111';
const COMPARISON_ID = '22222222-2222-4222-8222-222222222222';
const AUDIT_ID = '44444444-4444-4444-8444-444444444444';
const NEW_FINDING_ID = '99999999-9999-4999-8999-999999999999';

interface DriverRow {
  id: string;
  bill_comparison_id: string;
  category: string;
  title: string;
  summary: string;
  difference_cents: number;
  confidence: number;
  is_disputable: boolean;
  recommended_action: string | null;
  escalated_finding_id: string | null;
  bill_comparisons: {
    user_id: string;
    current_audit_id: string;
  } | null;
}

const {
  getUserMock,
  driverMaybeSingleMock,
  insertFindingMock,
  selectInsertedMock,
  updateDriverMock,
  selectAuditMock,
  updateAuditMock,
  deleteFindingMock,
  consumeRateLimitMock,
  inngestSendMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  driverMaybeSingleMock: vi.fn(),
  insertFindingMock: vi.fn(),
  selectInsertedMock: vi.fn(),
  updateDriverMock: vi.fn(),
  selectAuditMock: vi.fn(),
  updateAuditMock: vi.fn(),
  deleteFindingMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
  inngestSendMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: driverMaybeSingleMock }),
      }),
    }),
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      if (table === 'findings') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: () => {
                insertFindingMock(row);
                return selectInsertedMock();
              },
            }),
          }),
          delete: () => ({
            eq: async () => deleteFindingMock(),
          }),
        };
      }
      if (table === 'bill_change_drivers') {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: async () => updateDriverMock(patch),
          }),
        };
      }
      if (table === 'audits') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: selectAuditMock }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async () => updateAuditMock(patch),
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

vi.mock('@/inngest/client', () => ({
  inngest: { send: inngestSendMock },
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

import { POST } from '@/app/api/autopsy/drivers/[driverId]/escalate/route';

function makeContext(
  driverId: string = DRIVER_ID,
): { params: Promise<{ driverId: string }> } {
  return { params: Promise.resolve({ driverId }) };
}

function makeDriver(over: Partial<DriverRow> = {}): DriverRow {
  return {
    id: DRIVER_ID,
    bill_comparison_id: COMPARISON_ID,
    category: 'new_lines',
    title: 'A new line was added',
    summary: 'A new wireless line appeared this period.',
    difference_cents: 4500,
    confidence: 0.95,
    is_disputable: false,
    recommended_action: null,
    escalated_finding_id: null,
    bill_comparisons: { user_id: USER_ID, current_audit_id: AUDIT_ID },
    ...over,
  };
}

beforeEach(() => {
  getUserMock.mockReset();
  driverMaybeSingleMock.mockReset();
  insertFindingMock.mockReset();
  selectInsertedMock.mockReset();
  updateDriverMock.mockReset();
  selectAuditMock.mockReset();
  updateAuditMock.mockReset();
  deleteFindingMock.mockReset();
  consumeRateLimitMock.mockReset();
  inngestSendMock.mockReset();

  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID, email: 'u@example.com' } },
    error: null,
  });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    resetAt: new Date().toISOString(),
  });
  driverMaybeSingleMock.mockResolvedValue({
    data: makeDriver(),
    error: null,
  });
  selectInsertedMock.mockResolvedValue({
    data: { id: NEW_FINDING_ID },
    error: null,
  });
  updateDriverMock.mockResolvedValue({ error: null });
  selectAuditMock.mockResolvedValue({
    data: { finding_count: 5, high_severity_count: 1 },
    error: null,
  });
  updateAuditMock.mockResolvedValue({ error: null });
  deleteFindingMock.mockResolvedValue({ error: null });
  inngestSendMock.mockResolvedValue({ ids: ['evt_x'] });
});

describe('POST /escalate — validation + auth', () => {
  it('returns 400 when driverId is not a uuid', async () => {
    const res = await POST(new Request('http://localhost'), makeContext('bad'));
    expect(res.status).toBe(400);
  });

  it('returns 401 when no session', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(new Request('http://localhost'), makeContext());
    expect(res.status).toBe(401);
    expect(insertFindingMock).not.toHaveBeenCalled();
  });

  it('returns 404 when driver is RLS-hidden', async () => {
    driverMaybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(new Request('http://localhost'), makeContext());
    expect(res.status).toBe(404);
    expect(insertFindingMock).not.toHaveBeenCalled();
  });

  it('returns 404 when comparison is owned by a different user', async () => {
    driverMaybeSingleMock.mockResolvedValueOnce({
      data: makeDriver({
        bill_comparisons: { user_id: 'someone-else', current_audit_id: AUDIT_ID },
      }),
      error: null,
    });
    const res = await POST(new Request('http://localhost'), makeContext());
    expect(res.status).toBe(404);
    expect(insertFindingMock).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limit exhausted (per-user, 30/min)', async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      resetAt: new Date().toISOString(),
    });
    const res = await POST(new Request('http://localhost'), makeContext());
    expect(res.status).toBe(429);
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as {
      key: string;
      limit: number;
    };
    expect(call.key).toBe(`autopsy-escalate:${USER_ID}`);
    expect(call.limit).toBe(30);
  });
});

describe('POST /escalate — idempotency', () => {
  it('returns the existing findingId without inserting when already escalated', async () => {
    driverMaybeSingleMock.mockResolvedValueOnce({
      data: makeDriver({ escalated_finding_id: 'existing-finding-id' }),
      error: null,
    });
    const res = await POST(new Request('http://localhost'), makeContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      findingId: string;
      alreadyEscalated: boolean;
    };
    expect(body.findingId).toBe('existing-finding-id');
    expect(body.alreadyEscalated).toBe(true);
    expect(insertFindingMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });
});

describe('POST /escalate — severity + savings derivation', () => {
  it('emits HIGH severity + savings=|difference_cents| when disputable + bill went up', async () => {
    driverMaybeSingleMock.mockResolvedValueOnce({
      data: makeDriver({ is_disputable: true, difference_cents: 4500 }),
      error: null,
    });
    await POST(new Request('http://localhost'), makeContext());
    const row = insertFindingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.severity).toBe('high');
    expect(row.estimated_monthly_savings_cents).toBe(4500);
  });

  it('emits MEDIUM severity + savings=0 when NOT disputable (visibility only)', async () => {
    driverMaybeSingleMock.mockResolvedValueOnce({
      data: makeDriver({ is_disputable: false, difference_cents: 4500 }),
      error: null,
    });
    await POST(new Request('http://localhost'), makeContext());
    const row = insertFindingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.severity).toBe('medium');
    expect(row.estimated_monthly_savings_cents).toBe(0);
  });

  it('emits HIGH severity + savings=0 when disputable but bill went DOWN (negative diff)', async () => {
    // Disputable savings only count when the driver pushed the bill UP.
    driverMaybeSingleMock.mockResolvedValueOnce({
      data: makeDriver({ is_disputable: true, difference_cents: -2000 }),
      error: null,
    });
    await POST(new Request('http://localhost'), makeContext());
    const row = insertFindingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.severity).toBe('high');
    expect(row.estimated_monthly_savings_cents).toBe(0);
  });

  it('uses rule_id "autopsy_escalated_<category>" and carries category in evidence', async () => {
    driverMaybeSingleMock.mockResolvedValueOnce({
      data: makeDriver({ category: 'missing_credits' }),
      error: null,
    });
    await POST(new Request('http://localhost'), makeContext());
    const row = insertFindingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.rule_id).toBe('autopsy_escalated_missing_credits');
    const evidence = row.evidence as Record<string, unknown>;
    expect(evidence.autopsy_driver_id).toBe(DRIVER_ID);
    expect(evidence.category).toBe('missing_credits');
    expect(evidence.comparison_id).toBe(COMPARISON_ID);
  });

  it('uses driver.recommended_action when present, otherwise falls back', async () => {
    driverMaybeSingleMock.mockResolvedValueOnce({
      data: makeDriver({ recommended_action: 'Call carrier and dispute.' }),
      error: null,
    });
    await POST(new Request('http://localhost'), makeContext());
    const row = insertFindingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.recommended_action).toBe('Call carrier and dispute.');

    insertFindingMock.mockClear();
    driverMaybeSingleMock.mockResolvedValueOnce({
      data: makeDriver({ recommended_action: null }),
      error: null,
    });
    await POST(new Request('http://localhost'), makeContext());
    const row2 = insertFindingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row2.recommended_action).toContain('carrier rep');
  });

  it('sets status:"new" and nulls the affected_line_ids/affected_account_ids', async () => {
    await POST(new Request('http://localhost'), makeContext());
    const row = insertFindingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.status).toBe('new');
    expect(row.affected_line_ids).toBeNull();
    expect(row.affected_account_ids).toBeNull();
  });
});

describe('POST /escalate — rollback', () => {
  it('rolls back the inserted finding when driver-stamping fails', async () => {
    updateDriverMock.mockResolvedValueOnce({
      error: { message: 'stamp failed' },
    });
    const res = await POST(new Request('http://localhost'), makeContext());
    expect(res.status).toBe(500);
    expect(deleteFindingMock).toHaveBeenCalledTimes(1);
  });

  it('returns 500 with generic message when the finding insert fails', async () => {
    selectInsertedMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'unique violation' },
    });
    const res = await POST(new Request('http://localhost'), makeContext());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Failed to create finding.');
    expect(body.error).not.toContain('unique');
    expect(updateDriverMock).not.toHaveBeenCalled();
  });
});

describe('POST /escalate — audit counts + event dispatch', () => {
  it('bumps audit finding_count + high_severity_count when severity is high', async () => {
    driverMaybeSingleMock.mockResolvedValueOnce({
      data: makeDriver({ is_disputable: true, difference_cents: 4500 }),
      error: null,
    });
    await POST(new Request('http://localhost'), makeContext());
    const patch = updateAuditMock.mock.calls[0]?.[0] as Record<string, number>;
    expect(patch.finding_count).toBe(6); // 5 + 1
    expect(patch.high_severity_count).toBe(2); // 1 + 1 (high)
  });

  it('only bumps finding_count (not high_severity_count) when severity is medium', async () => {
    await POST(new Request('http://localhost'), makeContext());
    const patch = updateAuditMock.mock.calls[0]?.[0] as Record<string, number>;
    expect(patch.finding_count).toBe(6);
    expect(patch.high_severity_count).toBe(1); // unchanged
  });

  it('fires the finding.created event with title (not summary) for PII discipline', async () => {
    await POST(new Request('http://localhost'), makeContext());
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    const evt = inngestSendMock.mock.calls[0]?.[0] as {
      id: string;
      name: string;
      data: Record<string, unknown>;
    };
    expect(evt.id).toBe(`finding-created-${NEW_FINDING_ID}`);
    expect(evt.name).toBe('finding.created');
    expect(evt.data.title).toBe('A new line was added');
    // Critical: summary is NOT forwarded (it can carry richer context).
    expect(evt.data.summary).toBeUndefined();
  });

  it('does NOT fail the response when inngest.send throws', async () => {
    inngestSendMock.mockRejectedValueOnce(new Error('inngest down'));
    const res = await POST(new Request('http://localhost'), makeContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; findingId: string };
    expect(body.ok).toBe(true);
    expect(body.findingId).toBe(NEW_FINDING_ID);
  });
});
