import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  aggregateDigestContext,
  ensureUnsubToken,
  generateUnsubToken,
  selectDigestCohort,
  sendMonthlyDigestFn,
} from '@/inngest/functions/send-monthly-digest';
import { functions } from '@/inngest/functions';

/**
 * Tests for the monthly digest cron.
 *
 * Layers:
 *   1. Structural smoke — fn is registered, has the right id, has a name.
 *   2. selectDigestCohort — verifies the 25-day gate + opt-out filter +
 *      has-completed-audit requirement.
 *   3. ensureUnsubToken / generateUnsubToken — token shape + persistence.
 *   4. aggregateDigestContext — pulls audits, autopsy, findings, top lines.
 */

// ---------------------------------------------------------------------------
// Structural smoke
// ---------------------------------------------------------------------------

describe('sendMonthlyDigestFn (structural)', () => {
  it('has id "send-monthly-digest"', () => {
    expect(sendMonthlyDigestFn.id()).toContain('send-monthly-digest');
  });

  it('appears in the exported functions registry', () => {
    expect(functions).toContain(sendMonthlyDigestFn);
  });

  it('exposes a stable name', () => {
    expect(typeof sendMonthlyDigestFn.name).toBe('string');
    expect(sendMonthlyDigestFn.name.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test doubles — a fluent stub for the Supabase query builder used here
// ---------------------------------------------------------------------------

type QueryShape = {
  select?: string;
  filters: Array<[string, unknown[]]>;
  order?: { col: string; ascending: boolean };
  limit?: number;
  type: 'select' | 'update' | 'maybeSingle' | 'in';
};

type TableHandler = (calls: QueryShape) => { data: unknown; error: null | { message: string; code?: string } };

interface StubConfig {
  // For each (op, table) the handler decides what to return. Some tests
  // need multiple sequential calls — handler can read its own counter
  // via closure if needed.
  profiles?: TableHandler;
  audits?: TableHandler;
  bill_comparisons?: TableHandler;
  findings?: TableHandler;
  bill_lines?: TableHandler;
}

function makeStub(config: StubConfig): SupabaseClient {
  function fromTable(table: keyof StubConfig) {
    const calls: QueryShape = { filters: [], type: 'select' };
    const handler = config[table];
    const builder = {
      select(cols?: string) {
        calls.select = cols;
        return builder;
      },
      eq(col: string, val: unknown) {
        calls.filters.push([`eq:${col}`, [val]]);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        calls.filters.push([`in:${col}`, vals]);
        return builder;
      },
      is(col: string, val: unknown) {
        calls.filters.push([`is:${col}`, [val]]);
        return builder;
      },
      order(col: string, opts: { ascending: boolean }) {
        calls.order = { col, ascending: opts.ascending };
        return builder;
      },
      limit(n: number) {
        calls.limit = n;
        return builder;
      },
      update(_payload: unknown) {
        calls.type = 'update';
        return builder;
      },
      maybeSingle() {
        if (!handler) return Promise.resolve({ data: null, error: null });
        return Promise.resolve(handler({ ...calls, type: 'maybeSingle' }));
      },
      // Awaiting the builder returns a `{ data, error }` resolution.
      then(
        resolve: (v: { data: unknown; error: null | { message: string; code?: string } }) => unknown,
      ) {
        if (!handler) return resolve({ data: [], error: null });
        return resolve(handler(calls));
      },
    };
    return builder;
  }

  return {
    from: (table: string) => fromTable(table as keyof StubConfig),
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// selectDigestCohort
// ---------------------------------------------------------------------------

describe('selectDigestCohort', () => {
  const NOW = new Date('2026-06-01T14:00:00Z');
  const CUTOFF_ISO = new Date(
    NOW.getTime() - 25 * 24 * 60 * 60 * 1000,
  ).toISOString();

  it('skips opted-out users entirely (server-side filter)', async () => {
    const profilesHandler: TableHandler = vi.fn(() => ({
      data: [
        { id: 'u1', email: 'a@x', digest_opt_out: false, digest_last_sent_at: null, digest_unsub_token: null },
      ],
      error: null,
    }));
    const auditsHandler: TableHandler = vi.fn(() => ({
      data: [{ user_id: 'u1' }],
      error: null,
    }));
    const stub = makeStub({ profiles: profilesHandler, audits: auditsHandler });

    const cohort = await selectDigestCohort(stub, NOW);
    const mockedProfiles = profilesHandler as unknown as ReturnType<typeof vi.fn>;
    expect(mockedProfiles).toHaveBeenCalledTimes(1);
    const call = mockedProfiles.mock.calls[0]?.[0] as QueryShape | undefined;
    expect(call?.filters).toContainEqual(['eq:digest_opt_out', [false]]);
    expect(cohort.map((c) => c.id)).toEqual(['u1']);
  });

  it('filters out users whose last digest is within the 25-day window', async () => {
    const profilesHandler: TableHandler = vi.fn(() => ({
      data: [
        // recently-sent: yesterday → blocked
        {
          id: 'recent',
          email: 'r@x',
          digest_opt_out: false,
          digest_last_sent_at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
          digest_unsub_token: null,
        },
        // due: 26 days ago → eligible
        {
          id: 'due',
          email: 'd@x',
          digest_opt_out: false,
          digest_last_sent_at: new Date(NOW.getTime() - 26 * 24 * 60 * 60 * 1000).toISOString(),
          digest_unsub_token: null,
        },
        // never sent → eligible
        {
          id: 'new',
          email: 'n@x',
          digest_opt_out: false,
          digest_last_sent_at: null,
          digest_unsub_token: null,
        },
      ],
      error: null,
    }));
    const auditsHandler: TableHandler = vi.fn(() => ({
      data: [{ user_id: 'due' }, { user_id: 'new' }, { user_id: 'recent' }],
      error: null,
    }));
    const stub = makeStub({ profiles: profilesHandler, audits: auditsHandler });

    const cohort = await selectDigestCohort(stub, NOW);
    const ids = cohort.map((c) => c.id).sort();
    expect(ids).toEqual(['due', 'new']);
    expect(CUTOFF_ISO).toBeTruthy(); // sanity
  });

  it('drops users with no completed audit', async () => {
    const profilesHandler: TableHandler = vi.fn(() => ({
      data: [
        { id: 'has', email: 'h@x', digest_opt_out: false, digest_last_sent_at: null, digest_unsub_token: null },
        { id: 'never', email: 'n@x', digest_opt_out: false, digest_last_sent_at: null, digest_unsub_token: null },
      ],
      error: null,
    }));
    const auditsHandler: TableHandler = vi.fn(() => ({
      data: [{ user_id: 'has' }],
      error: null,
    }));
    const stub = makeStub({ profiles: profilesHandler, audits: auditsHandler });

    const cohort = await selectDigestCohort(stub, NOW);
    expect(cohort.map((c) => c.id)).toEqual(['has']);
  });

  it('drops users without an email', async () => {
    const profilesHandler: TableHandler = vi.fn(() => ({
      data: [
        { id: 'no-email', email: null, digest_opt_out: false, digest_last_sent_at: null, digest_unsub_token: null },
      ],
      error: null,
    }));
    const stub = makeStub({ profiles: profilesHandler });
    const cohort = await selectDigestCohort(stub, NOW);
    expect(cohort).toEqual([]);
  });

  it('reports hasToken for users that already have a digest_unsub_token', async () => {
    const profilesHandler: TableHandler = vi.fn(() => ({
      data: [
        {
          id: 'tok',
          email: 't@x',
          digest_opt_out: false,
          digest_last_sent_at: null,
          digest_unsub_token: 'existing-token',
        },
      ],
      error: null,
    }));
    const auditsHandler: TableHandler = vi.fn(() => ({
      data: [{ user_id: 'tok' }],
      error: null,
    }));
    const stub = makeStub({ profiles: profilesHandler, audits: auditsHandler });
    const cohort = await selectDigestCohort(stub, NOW);
    expect(cohort).toEqual([{ id: 'tok', email: 't@x', hasToken: true }]);
  });
});

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

describe('generateUnsubToken', () => {
  it('produces a 32-char base64url string', () => {
    const token = generateUnsubToken();
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces distinct tokens on successive calls', () => {
    const a = generateUnsubToken();
    const b = generateUnsubToken();
    expect(a).not.toBe(b);
  });
});

describe('ensureUnsubToken', () => {
  it('returns the existing token without writing if one is already set', async () => {
    const updateHandler = vi.fn();
    let calls = 0;
    const profilesHandler: TableHandler = (q) => {
      calls += 1;
      if (q.type === 'update') {
        updateHandler(q);
        return { data: [], error: null };
      }
      return {
        data: { digest_unsub_token: 'already-set' },
        error: null,
      };
    };
    const stub = makeStub({ profiles: profilesHandler });

    const out = await ensureUnsubToken(stub, 'u1');
    expect(out).toBe('already-set');
    expect(updateHandler).not.toHaveBeenCalled();
    expect(calls).toBe(1);
  });

  it('mints a fresh token and persists via CAS on null', async () => {
    let phase: 'read' | 'write' = 'read';
    const writes: QueryShape[] = [];
    const profilesHandler: TableHandler = (q) => {
      if (q.type === 'update') {
        writes.push(q);
        // CAS wins → exactly one row returned with the new token.
        return { data: [{ digest_unsub_token: 'whatever' }], error: null };
      }
      if (phase === 'read') {
        phase = 'write';
        return { data: { digest_unsub_token: null }, error: null };
      }
      return { data: { digest_unsub_token: null }, error: null };
    };
    const stub = makeStub({ profiles: profilesHandler });

    const out = await ensureUnsubToken(stub, 'u1');
    expect(out).toHaveLength(32);
    expect(writes).toHaveLength(1);
    const write = writes[0];
    expect(write?.filters).toContainEqual(['eq:id', ['u1']]);
    expect(write?.filters).toContainEqual(['is:digest_unsub_token', [null]]);
  });
});

// ---------------------------------------------------------------------------
// aggregateDigestContext
// ---------------------------------------------------------------------------

describe('aggregateDigestContext', () => {
  it('aggregates spend, autopsy, open findings, and the top unused lines', async () => {
    const auditsHandler: TableHandler = vi.fn(() => ({
      data: [
        { id: 'a1', total_charges_cents: 100_00, completed_at: '2026-05-15T00:00:00Z' },
        { id: 'a2', total_charges_cents: 150_00, completed_at: '2026-04-15T00:00:00Z' },
      ],
      error: null,
    }));
    const comparisonsHandler = vi.fn(() => ({
      data: [
        {
          net_change_cents: 5_000,
          disputable_cents: 2_000,
          optimization_cents: 1_500,
          created_at: '2026-05-20T00:00:00Z',
        },
      ],
      error: null,
    }));
    const findingsHandler = vi.fn(() => ({
      data: [
        {
          id: 'f1',
          severity: 'high',
          status: 'new',
          rule_id: 'zero_usage_phone_line',
          estimated_monthly_savings_cents: 4_000,
          affected_line_ids: ['line-1'],
        },
        {
          id: 'f2',
          severity: 'medium',
          status: 'in_review',
          rule_id: 'suspended_line_billed',
          estimated_monthly_savings_cents: 2_500,
          affected_line_ids: ['line-2'],
        },
        {
          id: 'f3',
          severity: 'low',
          status: 'approved',
          rule_id: 'expired_promo_credit', // not in the waste set
          estimated_monthly_savings_cents: 1_000,
          affected_line_ids: ['line-3'],
        },
      ],
      error: null,
    }));
    const linesHandler = vi.fn(() => ({
      data: [
        { id: 'line-1', user_label: 'Office iPad', mdn_masked: '1111' },
        { id: 'line-2', user_label: null, mdn_masked: '2222' },
      ],
      error: null,
    }));

    const stub = makeStub({
      audits: auditsHandler,
      bill_comparisons: comparisonsHandler,
      findings: findingsHandler,
      bill_lines: linesHandler,
    });

    const out = await aggregateDigestContext(stub, 'u1');
    expect(out.totalSpendCents).toBe(250_00);
    expect(out.autopsy).toEqual({
      netChangeCents: 5_000,
      disputableCents: 2_000,
      optimizationCents: 1_500,
    });
    expect(out.openFindingsBySeverity).toEqual({ high: 1, medium: 1, low: 1 });
    // Recoverable savings sums ALL open findings, not just waste-rule ones.
    expect(out.totalRecoverableSavingsCents).toBe(7_500);
    // Top lines come from waste-rule findings, sorted by per-line savings desc.
    expect(out.topUnusedLines).toEqual([
      {
        label: 'Office iPad',
        mdnMaskedLast4: '1111',
        ruleId: 'zero_usage_phone_line',
        estimatedMonthlySavingsCents: 4_000,
      },
      {
        label: null,
        mdnMaskedLast4: '2222',
        ruleId: 'suspended_line_billed',
        estimatedMonthlySavingsCents: 2_500,
      },
    ]);
  });

  it('returns autopsy null when no comparison row exists', async () => {
    const auditsHandler: TableHandler = vi.fn(() => ({
      data: [{ id: 'a1', total_charges_cents: 0, completed_at: '2026-05-15T00:00:00Z' }],
      error: null,
    }));
    const comparisonsHandler = vi.fn(() => ({ data: [], error: null }));
    const findingsHandler = vi.fn(() => ({ data: [], error: null }));

    const stub = makeStub({
      audits: auditsHandler,
      bill_comparisons: comparisonsHandler,
      findings: findingsHandler,
    });

    const out = await aggregateDigestContext(stub, 'u1');
    expect(out.autopsy).toBeNull();
    expect(out.totalRecoverableSavingsCents).toBe(0);
    expect(out.topUnusedLines).toEqual([]);
  });

  it('returns empty defaults when the user has no completed audits', async () => {
    const auditsHandler: TableHandler = vi.fn(() => ({ data: [], error: null }));
    const stub = makeStub({ audits: auditsHandler });

    const out = await aggregateDigestContext(stub, 'u1');
    expect(out.totalSpendCents).toBe(0);
    expect(out.autopsy).toBeNull();
    expect(out.openFindingsBySeverity).toEqual({ high: 0, medium: 0, low: 0 });
    expect(out.topUnusedLines).toEqual([]);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
