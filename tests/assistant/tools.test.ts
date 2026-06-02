import { beforeEach, describe, expect, it } from 'vitest';

import {
  executeGetAuditSummary,
  executeGetAutopsy,
  executeGetFinding,
  executeListAudits,
  executeListFindings,
  executeListLines,
  freezeCitations,
  newCitationCollector,
  type AssistantSupabase,
  type ToolContext,
} from '@/lib/assistant/tools';

// ---------------------------------------------------------------------------
// Supabase mock harness
// ---------------------------------------------------------------------------
//
// The tools call .from(table).select(cols).eq(...).maybeSingle() etc. We mimic
// the supabase-js builder by returning a chainable thenable: every chained
// call appends to an in-memory filter list and returns the same builder,
// which resolves with the configured row set. This lets each test register
// fixture rows per table without writing a fresh mock for every method shape.
//
// The chain only supports the methods the tools actually use. Adding new
// methods (e.g. .gte()) is a one-liner — extend the `passthrough` list.

type Row = Record<string, unknown>;

interface PendingQuery {
  table: string;
  filters: Array<{ op: string; key: string; value: unknown }>;
  selected: string | null;
  inFilter?: { key: string; values: unknown[] };
  ordered?: { column: string; ascending: boolean };
  limited?: number;
}

interface FakeRow {
  table: string;
  rows: Row[];
}

function makeFakeSupabase(): {
  client: AssistantSupabase;
  seed: (table: string, rows: Row[]) => void;
  reset: () => void;
} {
  let storage: FakeRow[] = [];

  function rowsMatching(q: PendingQuery): Row[] {
    const set = storage.find((s) => s.table === q.table);
    if (!set) return [];
    let out = set.rows;
    for (const f of q.filters) {
      if (f.op === 'eq') out = out.filter((r) => r[f.key] === f.value);
    }
    if (q.inFilter) {
      const { key, values } = q.inFilter;
      out = out.filter((r) => values.includes(r[key]));
    }
    if (q.ordered) {
      const { column, ascending } = q.ordered;
      out = [...out].sort((a, b) => {
        const av = a[column];
        const bv = b[column];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av > bv) return ascending ? 1 : -1;
        return ascending ? -1 : 1;
      });
    }
    if (typeof q.limited === 'number') out = out.slice(0, q.limited);
    return out;
  }

  function makeBuilder(table: string) {
    const q: PendingQuery = { table, filters: [], selected: null };
    const builder: Record<string, unknown> = {};

    builder.select = (cols: string) => {
      q.selected = cols;
      return builder;
    };
    builder.eq = (key: string, value: unknown) => {
      q.filters.push({ op: 'eq', key, value });
      return builder;
    };
    builder.in = (key: string, values: unknown[]) => {
      q.inFilter = { key, values };
      return builder;
    };
    builder.order = (column: string, opts?: { ascending?: boolean }) => {
      q.ordered = { column, ascending: opts?.ascending ?? true };
      return builder;
    };
    builder.limit = (n: number) => {
      q.limited = n;
      return builder;
    };
    builder.maybeSingle = async () => {
      const rows = rowsMatching(q);
      return { data: rows[0] ?? null, error: null };
    };
    // Plain awaited builder resolves to {data: rows[], error: null}.
    builder.then = (resolve: (v: { data: Row[]; error: null }) => void) => {
      resolve({ data: rowsMatching(q), error: null });
    };
    return builder;
  }

  const client: AssistantSupabase = {
    from: (table: string) => makeBuilder(table) as unknown as ReturnType<AssistantSupabase['from']>,
  };

  return {
    client,
    seed: (table, rows) => {
      const existing = storage.find((s) => s.table === table);
      if (existing) existing.rows = [...existing.rows, ...rows];
      else storage.push({ table, rows: [...rows] });
    },
    reset: () => {
      storage = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const AUDIT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AUDIT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FINDING_A = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const FINDING_B = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const LINE_1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const LINE_2 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ACCOUNT_1 = '99999999-9999-9999-9999-999999999999';

const fixture = makeFakeSupabase();

function seedFixtures() {
  fixture.reset();
  fixture.seed('audits', [
    {
      id: AUDIT_A,
      user_id: USER_A,
      status: 'completed',
      carrier: 'verizon',
      billing_period_start: '2026-04-01',
      billing_period_end: '2026-04-30',
      total_charges_cents: 248_500,
      account_count: 1,
      line_count: 2,
      finding_count: 2,
      high_severity_count: 1,
      estimated_monthly_savings_cents: 4_500,
      estimated_annual_savings_cents: 54_000,
      created_at: '2026-05-02T12:00:00Z',
      completed_at: '2026-05-02T12:05:00Z',
    },
    {
      id: AUDIT_B,
      user_id: USER_B, // owned by another user — must be invisible to USER_A
      status: 'completed',
      carrier: 'att',
      billing_period_start: '2026-04-01',
      billing_period_end: '2026-04-30',
      total_charges_cents: 88_000,
      account_count: 1,
      line_count: 1,
      finding_count: 0,
      high_severity_count: 0,
      estimated_monthly_savings_cents: 0,
      estimated_annual_savings_cents: 0,
      created_at: '2026-05-02T12:10:00Z',
      completed_at: '2026-05-02T12:15:00Z',
    },
  ]);
  fixture.seed('findings', [
    {
      id: FINDING_A,
      audit_id: AUDIT_A,
      rule_id: 'expired-promo-credit',
      severity: 'high',
      title: 'Expired promo credit on line 4821',
      description: 'A $10/mo promo credit ended on 2026-04-01; the line is now paying full price.',
      recommended_action: 'Call carrier and request a new promo credit.',
      estimated_monthly_savings_cents: 1000,
      confidence: 0.95,
      status: 'new',
      created_at: '2026-05-02T12:05:00Z',
      affected_line_ids: [LINE_1],
      affected_account_ids: [ACCOUNT_1],
      evidence: { source: 'unit-test' },
    },
    {
      id: FINDING_B,
      audit_id: AUDIT_B, // belongs to USER_B's audit
      rule_id: 'unused-data',
      severity: 'low',
      title: 'Line uses <1GB on unlimited plan',
      description: 'Could downgrade to a smaller plan.',
      recommended_action: 'Review plan.',
      estimated_monthly_savings_cents: 500,
      confidence: 0.6,
      status: 'new',
      created_at: '2026-05-02T12:15:00Z',
      affected_line_ids: [],
      affected_account_ids: [],
      evidence: {},
    },
  ]);
  fixture.seed('bill_accounts', [
    {
      id: ACCOUNT_1,
      audit_id: AUDIT_A,
      account_number_masked: '****1234',
    },
  ]);
  fixture.seed('bill_lines', [
    {
      id: LINE_1,
      audit_id: AUDIT_A,
      account_id: ACCOUNT_1,
      mdn_masked: '5551234821', // intentionally a "too long" value so we can
      // verify takeLast4 truncates to last 4 only
      plan_name: 'Business Unlimited Pro 2.0',
      plan_base_cents: 9000,
      data_used_gb: 12.4,
      voice_used_min: 60,
      sms_used_count: 12,
      is_suspended: false,
      is_active_dpp: false,
    },
    {
      id: LINE_2,
      audit_id: AUDIT_A,
      account_id: ACCOUNT_1,
      mdn_masked: '5550009922',
      plan_name: 'Business Unlimited Start 2.0',
      plan_base_cents: 4000,
      data_used_gb: 0.1,
      voice_used_min: 0,
      sms_used_count: 0,
      is_suspended: false,
      is_active_dpp: false,
    },
  ]);
  fixture.seed('bill_features', [
    {
      id: 'feature-1',
      line_id: LINE_1,
      audit_id: AUDIT_A,
      name: 'Total Mobile Protection',
      category: 'insurance',
      monthly_charge_cents: 1500,
    },
  ]);
  fixture.seed('bill_comparisons', [
    {
      id: 'comparison-1',
      user_id: USER_A,
      previous_audit_id: AUDIT_B,
      current_audit_id: AUDIT_A,
      previous_total_cents: 200_000,
      current_total_cents: 248_500,
      net_change_cents: 48_500,
      percent_change_bps: 2425,
      disputable_cents: 12_000,
      optimization_cents: 6_500,
      unexplained_cents: 0,
      executive_summary: 'Bill rose 24% due to a new line + an expired credit.',
      created_at: '2026-05-03T10:00:00Z',
    },
  ]);
  fixture.seed('bill_change_drivers', [
    {
      id: 'driver-1',
      bill_comparison_id: 'comparison-1',
      category: 'new_lines',
      title: 'New line on the bill',
      summary: 'Line ending 9922 was added this period.',
      previous_cents: 0,
      current_cents: 4000,
      difference_cents: 4000,
      affected_lines_count: 1,
      confidence: 1,
      is_disputable: false,
      is_optimization: false,
      is_unexplained: false,
      recommended_action: null,
    },
  ]);
}

beforeEach(() => {
  seedFixtures();
});

function ctxFor(userId: string): ToolContext {
  return { supabase: fixture.client, userId };
}

// ---------------------------------------------------------------------------
// list_audits
// ---------------------------------------------------------------------------

describe('executeListAudits', () => {
  it('returns only audits owned by the calling user', async () => {
    const citations = newCitationCollector();
    const result = (await executeListAudits({}, ctxFor(USER_A), citations)) as {
      audits: Array<{ id: string }>;
    };
    expect(result.audits.map((a) => a.id)).toEqual([AUDIT_A]);
    expect(freezeCitations(citations).audit_ids).toContain(AUDIT_A);
  });

  it('returns an empty list for a user with no audits', async () => {
    const citations = newCitationCollector();
    const result = (await executeListAudits(
      {},
      ctxFor('33333333-3333-3333-3333-333333333333'),
      citations,
    )) as { audits: unknown[] };
    expect(result.audits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// get_audit_summary
// ---------------------------------------------------------------------------

describe('executeGetAuditSummary', () => {
  it('returns the audit when the caller owns it', async () => {
    const citations = newCitationCollector();
    const result = (await executeGetAuditSummary(
      { audit_id: AUDIT_A },
      ctxFor(USER_A),
      citations,
    )) as { audit: { id: string; user_id?: string } | null };
    expect(result.audit?.id).toBe(AUDIT_A);
    // user_id must be stripped before being returned to the model
    expect(result.audit && 'user_id' in result.audit).toBe(false);
  });

  it('returns missing when audit belongs to another user', async () => {
    const citations = newCitationCollector();
    const result = (await executeGetAuditSummary(
      { audit_id: AUDIT_B }, // owned by USER_B
      ctxFor(USER_A),
      citations,
    )) as { audit: unknown; missing?: string };
    expect(result.audit).toBeNull();
    expect(result.missing).toBeDefined();
    expect(freezeCitations(citations).audit_ids).toEqual([]);
  });

  it('rejects an invalid UUID input via Zod', async () => {
    const citations = newCitationCollector();
    await expect(
      executeGetAuditSummary({ audit_id: 'not-a-uuid' }, ctxFor(USER_A), citations),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// list_findings
// ---------------------------------------------------------------------------

describe('executeListFindings', () => {
  it('returns findings for an owned audit', async () => {
    const citations = newCitationCollector();
    const result = (await executeListFindings(
      { audit_id: AUDIT_A },
      ctxFor(USER_A),
      citations,
    )) as { findings: Array<{ id: string }> };
    expect(result.findings.map((f) => f.id)).toEqual([FINDING_A]);
    expect(freezeCitations(citations).finding_ids).toContain(FINDING_A);
  });

  it('returns missing when audit is not owned by the caller', async () => {
    const citations = newCitationCollector();
    const result = (await executeListFindings(
      { audit_id: AUDIT_B },
      ctxFor(USER_A),
      citations,
    )) as { findings: unknown[]; missing?: string };
    expect(result.findings).toEqual([]);
    expect(result.missing).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// get_finding
// ---------------------------------------------------------------------------

describe('executeGetFinding', () => {
  it('returns the finding with last-4 MDNs only and strips evidence/UUID arrays', async () => {
    const citations = newCitationCollector();
    const result = (await executeGetFinding(
      { finding_id: FINDING_A },
      ctxFor(USER_A),
      citations,
    )) as {
      finding: {
        id: string;
        affected_line_last4: string[];
        affected_account_last4: string[];
        affected_line_ids?: unknown;
        affected_account_ids?: unknown;
        evidence?: unknown;
      } | null;
    };
    expect(result.finding?.id).toBe(FINDING_A);
    // MDNs are truncated to last 4 even when source row has a longer string
    expect(result.finding?.affected_line_last4).toEqual(['4821']);
    expect(result.finding?.affected_account_last4).toEqual(['1234']);
    expect(result.finding && 'affected_line_ids' in result.finding).toBe(false);
    expect(result.finding && 'affected_account_ids' in result.finding).toBe(false);
    expect(result.finding && 'evidence' in result.finding).toBe(false);
  });

  it('returns missing when the finding belongs to another user', async () => {
    const citations = newCitationCollector();
    const result = (await executeGetFinding(
      { finding_id: FINDING_B }, // attached to AUDIT_B → USER_B
      ctxFor(USER_A),
      citations,
    )) as { finding: unknown };
    expect(result.finding).toBeNull();
    expect(freezeCitations(citations).finding_ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// get_autopsy
// ---------------------------------------------------------------------------

describe('executeGetAutopsy', () => {
  it('returns the latest comparison and drivers for an owned audit', async () => {
    const citations = newCitationCollector();
    const result = (await executeGetAutopsy({ audit_id: AUDIT_A }, ctxFor(USER_A), citations)) as {
      comparison: { id: string; user_id?: string } | null;
      drivers: Array<{ id: string }>;
    };
    expect(result.comparison?.id).toBe('comparison-1');
    expect(result.drivers.map((d) => d.id)).toEqual(['driver-1']);
    // user_id stripped before returning
    expect(result.comparison && 'user_id' in result.comparison).toBe(false);
    expect(freezeCitations(citations).comparison_ids).toContain('comparison-1');
  });

  it('returns missing-comparison when audit owned but no comparison exists', async () => {
    fixture.reset();
    fixture.seed('audits', [
      {
        id: AUDIT_A,
        user_id: USER_A,
        status: 'completed',
        carrier: 'verizon',
        billing_period_start: null,
        billing_period_end: null,
        total_charges_cents: 0,
        account_count: 0,
        line_count: 0,
        finding_count: 0,
        high_severity_count: 0,
        estimated_monthly_savings_cents: 0,
        estimated_annual_savings_cents: 0,
        created_at: '2026-05-02T12:00:00Z',
        completed_at: null,
      },
    ]);
    const citations = newCitationCollector();
    const result = (await executeGetAutopsy({ audit_id: AUDIT_A }, ctxFor(USER_A), citations)) as {
      comparison: unknown;
      missing?: string;
    };
    expect(result.comparison).toBeNull();
    expect(result.missing).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// list_lines
// ---------------------------------------------------------------------------

describe('executeListLines', () => {
  it('returns mdn_last4 only (PII discipline) and includes account_last4', async () => {
    const citations = newCitationCollector();
    const result = (await executeListLines({ audit_id: AUDIT_A }, ctxFor(USER_A), citations)) as {
      lines: Array<{ mdn_last4: string; account_last4: string }>;
    };
    expect(result.lines).toHaveLength(2);
    const mdns = result.lines.map((l) => l.mdn_last4);
    expect(mdns).toContain('4821');
    expect(mdns).toContain('9922');
    // None of the returned strings should be longer than 4 chars
    for (const line of result.lines) {
      expect(line.mdn_last4.length).toBeLessThanOrEqual(4);
      expect(line.account_last4.length).toBeLessThanOrEqual(4);
    }
  });

  it('filters by has_feature', async () => {
    const citations = newCitationCollector();
    const result = (await executeListLines(
      { audit_id: AUDIT_A, has_feature: 'insurance' },
      ctxFor(USER_A),
      citations,
    )) as { lines: Array<{ mdn_last4: string }> };
    // Only LINE_1 has the insurance feature in fixtures
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.mdn_last4).toBe('4821');
  });

  it('returns missing when audit not owned', async () => {
    const citations = newCitationCollector();
    const result = (await executeListLines({ audit_id: AUDIT_B }, ctxFor(USER_A), citations)) as {
      lines: unknown[];
      missing?: string;
    };
    expect(result.lines).toEqual([]);
    expect(result.missing).toBeDefined();
  });
});
