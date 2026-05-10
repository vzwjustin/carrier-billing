import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

const { handleStripeEventMock } = vi.hoisted(() => ({
  handleStripeEventMock:
    vi.fn<
      (
        event: Stripe.Event,
        supabase: unknown,
        ctx?: { previousStatus: 'success' | 'failed' | null },
      ) => Promise<void>
    >(),
}));

vi.mock('@/lib/stripe/handlers', () => ({
  handleStripeEvent: (
    event: Stripe.Event,
    supabase: unknown,
    ctx?: { previousStatus: 'success' | 'failed' | null },
  ) => handleStripeEventMock(event, supabase, ctx),
}));

import {
  findReplayCandidates,
  REPLAY_COOLDOWN_SECONDS,
  REPLAY_LOOKBACK_HOURS,
  replayBillingEvent,
  replayBillingEventsFn,
  type ReplayCandidate,
} from '@/inngest/functions/replay-billing-events';
import { functions } from '@/inngest/functions';

/**
 * Tests for replay-billing-events (H8 recovery cron).
 *
 * Two layers, mirroring the cleanup-orphan-audits pattern:
 *   1. Structural — cron exists, registered, scheduled.
 *   2. Behavioral — `findReplayCandidates` respects lookback / cooldown,
 *      `replayBillingEvent` re-invokes the handler with previousStatus='failed'
 *      and writes the right bookkeeping.
 */

describe('replayBillingEventsFn (structural)', () => {
  it('has id "replay-billing-events"', () => {
    expect(replayBillingEventsFn.id()).toContain('replay-billing-events');
  });

  it('is registered in the Inngest functions list', () => {
    expect(functions).toContain(replayBillingEventsFn);
  });
});

// --- Mocked supabase surface for findReplayCandidates ---------------------

type SelectChain = {
  rows: Array<Record<string, unknown>>;
  filters: Array<{ method: string; args: unknown[] }>;
};

function makeFilterableSelect(
  rows: Array<Record<string, unknown>>,
  filters: Array<{ method: string; args: unknown[] }>,
): SelectChain & { [K: string]: unknown } {
  const chain = {
    rows,
    filters,
    is(col: string, value: unknown) {
      filters.push({ method: 'is', args: [col, value] });
      return chain;
    },
    eq(col: string, value: unknown) {
      filters.push({ method: 'eq', args: [col, value] });
      return chain;
    },
    gte(col: string, value: unknown) {
      filters.push({ method: 'gte', args: [col, value] });
      return chain;
    },
    lte(col: string, value: unknown) {
      filters.push({ method: 'lte', args: [col, value] });
      return chain;
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    then(
      resolve: (v: {
        data: Array<Record<string, unknown>>;
        error: null;
      }) => void,
    ) {
      // Apply filters in-memory so each test can stage one source dataset and
      // get correct partitions across the three queries the function fires.
      let filtered = [...rows];
      for (const f of filters) {
        const [col, val] = f.args as [string, unknown];
        if (f.method === 'is' && val === null) {
          filtered = filtered.filter((r) => r[col] === null);
        } else if (f.method === 'eq') {
          filtered = filtered.filter((r) => r[col] === val);
        } else if (f.method === 'gte') {
          filtered = filtered.filter(
            (r) => typeof r[col] === 'string' && (r[col] as string) >= (val as string),
          );
        } else if (f.method === 'lte') {
          filtered = filtered.filter(
            (r) => typeof r[col] === 'string' && (r[col] as string) <= (val as string),
          );
        }
      }
      resolve({ data: filtered, error: null });
    },
  } as SelectChain & { [K: string]: unknown };
  return chain;
}

function makeSupabaseStub(
  source: Array<Record<string, unknown>>,
  updateLog: Array<{ patch: Record<string, unknown>; eq: [string, unknown] }>,
): SupabaseClient {
  const client = {
    from() {
      return {
        select() {
          return makeFilterableSelect(source, []);
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(col: string, val: unknown) {
              updateLog.push({ patch, eq: [col, val] });
              const r = source.find((row) => row['id'] === val);
              if (r) {
                for (const [k, v] of Object.entries(patch)) {
                  r[k] = v;
                }
              }
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return client as unknown as SupabaseClient;
}

const NOW = new Date('2026-05-09T12:00:00.000Z');

function tsBefore(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

beforeEach(() => {
  handleStripeEventMock.mockReset();
  handleStripeEventMock.mockResolvedValue(undefined);
});

describe('findReplayCandidates', () => {
  it('picks up rows with processed_status=null older than the cooldown window', async () => {
    const source = [
      {
        id: 'be_unprocessed_old',
        stripe_event_id: 'evt_old',
        type: 't',
        payload: {},
        processed_status: null,
        last_attempted_at: null,
        created_at: tsBefore(REPLAY_COOLDOWN_SECONDS + 30),
      },
    ];
    const candidates = await findReplayCandidates(makeSupabaseStub(source, []), NOW);
    expect(candidates.map((c) => c.id)).toEqual(['be_unprocessed_old']);
  });

  it('skips rows with processed_status=null still inside the cooldown window', async () => {
    const source = [
      {
        id: 'be_just_inserted',
        stripe_event_id: 'evt_recent',
        type: 't',
        payload: {},
        processed_status: null,
        last_attempted_at: null,
        created_at: tsBefore(10),
      },
    ];
    const candidates = await findReplayCandidates(makeSupabaseStub(source, []), NOW);
    expect(candidates).toEqual([]);
  });

  it('skips rows older than the 24h lookback window', async () => {
    const source = [
      {
        id: 'be_too_old',
        stripe_event_id: 'evt_ancient',
        type: 't',
        payload: {},
        processed_status: 'failed',
        last_attempted_at: tsBefore(REPLAY_COOLDOWN_SECONDS + 30),
        created_at: tsBefore(REPLAY_LOOKBACK_HOURS * 3600 + 60),
      },
    ];
    const candidates = await findReplayCandidates(makeSupabaseStub(source, []), NOW);
    expect(candidates).toEqual([]);
  });

  it('picks up failed rows whose last_attempted_at has cooled (>60s)', async () => {
    const source = [
      {
        id: 'be_failed_cooled',
        stripe_event_id: 'evt_cooled',
        type: 't',
        payload: {},
        processed_status: 'failed',
        last_attempted_at: tsBefore(REPLAY_COOLDOWN_SECONDS + 30),
        created_at: tsBefore(120),
      },
    ];
    const candidates = await findReplayCandidates(makeSupabaseStub(source, []), NOW);
    expect(candidates.map((c) => c.id)).toEqual(['be_failed_cooled']);
  });

  it('skips failed rows whose last_attempted_at is still inside the cooldown', async () => {
    const source = [
      {
        id: 'be_failed_recent',
        stripe_event_id: 'evt_hot',
        type: 't',
        payload: {},
        processed_status: 'failed',
        last_attempted_at: tsBefore(20),
        created_at: tsBefore(120),
      },
    ];
    const candidates = await findReplayCandidates(makeSupabaseStub(source, []), NOW);
    expect(candidates).toEqual([]);
  });

  it('picks up failed rows that have never been attempted (last_attempted_at IS NULL)', async () => {
    const source = [
      {
        id: 'be_failed_never_attempted',
        stripe_event_id: 'evt_orphan',
        type: 't',
        payload: {},
        processed_status: 'failed',
        last_attempted_at: null,
        created_at: tsBefore(60 * 60),
      },
    ];
    const candidates = await findReplayCandidates(makeSupabaseStub(source, []), NOW);
    expect(candidates.map((c) => c.id)).toEqual(['be_failed_never_attempted']);
  });

  it('does NOT pick up rows already marked processed=success', async () => {
    const source = [
      {
        id: 'be_done',
        stripe_event_id: 'evt_done',
        type: 't',
        payload: {},
        processed_status: 'success',
        last_attempted_at: tsBefore(120),
        created_at: tsBefore(120),
      },
    ];
    const candidates = await findReplayCandidates(makeSupabaseStub(source, []), NOW);
    expect(candidates).toEqual([]);
  });

  it('de-duplicates rows that satisfy multiple selection branches', async () => {
    const row = {
      id: 'be_dup_predicate',
      stripe_event_id: 'evt_dup_pred',
      type: 't',
      payload: {},
      processed_status: 'failed',
      last_attempted_at: null, // matches "never attempted" branch
      created_at: tsBefore(60),
    };
    // Only one row; both `failed-no-attempt` and `failed-cooled` queries
    // could conceivably match if cooled timestamp predicates also hit. The
    // merge pass should still yield exactly one entry.
    const candidates = await findReplayCandidates(
      makeSupabaseStub([row], []),
      NOW,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe('be_dup_predicate');
  });
});

describe('replayBillingEvent', () => {
  const VALID_PAYLOAD = {
    id: 'evt_x',
    type: 'invoice.payment_failed',
    created: 1_700_000_000,
    data: { object: { id: 'in_x', customer: 'cus_x' } },
  };

  function makeRow(payload: unknown, type = 'invoice.payment_failed'): ReplayCandidate {
    return {
      id: 'be_target',
      stripe_event_id: 'evt_x',
      type,
      payload,
      processed_status: 'failed',
      last_attempted_at: null,
    };
  }

  it('handler success ⇒ row marked success, processed_at set, last_error cleared', async () => {
    const updates: Array<{ patch: Record<string, unknown>; eq: [string, unknown] }> = [];
    const supabase = makeSupabaseStub([], updates);
    const outcome = await replayBillingEvent(supabase, makeRow(VALID_PAYLOAD), NOW);
    expect(outcome).toBe('success');

    // Two updates expected: mark attempt + mark success.
    expect(updates).toHaveLength(2);
    expect(updates[0]?.patch).toEqual({ last_attempted_at: NOW.toISOString() });
    expect(updates[1]?.patch.processed_status).toBe('success');
    expect(updates[1]?.patch.processed_at).toBe(NOW.toISOString());
    expect(updates[1]?.patch.last_error).toBeNull();
  });

  it('always passes previousStatus=failed to the handler so non-idempotent ops short-circuit', async () => {
    const updates: Array<{ patch: Record<string, unknown>; eq: [string, unknown] }> = [];
    await replayBillingEvent(makeSupabaseStub([], updates), makeRow(VALID_PAYLOAD), NOW);
    expect(handleStripeEventMock).toHaveBeenCalledTimes(1);
    expect(handleStripeEventMock.mock.calls[0]?.[2]).toEqual({
      previousStatus: 'failed',
    });
  });

  it('handler failure ⇒ row stays failed, last_error captured + redacted', async () => {
    handleStripeEventMock.mockRejectedValueOnce(
      new Error('network blip touching user@example.com 9876543210'),
    );
    const updates: Array<{ patch: Record<string, unknown>; eq: [string, unknown] }> = [];
    const outcome = await replayBillingEvent(
      makeSupabaseStub([], updates),
      makeRow(VALID_PAYLOAD),
      NOW,
    );
    expect(outcome).toBe('failed');
    const failurePatch = updates[1]?.patch as Record<string, unknown>;
    expect(failurePatch.processed_status).toBe('failed');
    expect(typeof failurePatch.last_error).toBe('string');
    // PII scrubbed by `scrubString`.
    expect(failurePatch.last_error).not.toContain('user@example.com');
    expect(failurePatch.last_error).not.toContain('9876543210');
  });

  it('invalid payload (non-object or type mismatch) ⇒ row marked failed, handler not called', async () => {
    const updates: Array<{ patch: Record<string, unknown>; eq: [string, unknown] }> = [];
    const outcome = await replayBillingEvent(
      makeSupabaseStub([], updates),
      makeRow(null),
      NOW,
    );
    expect(outcome).toBe('invalid_payload');
    expect(handleStripeEventMock).not.toHaveBeenCalled();
    expect(updates[1]?.patch.processed_status).toBe('failed');
    expect(updates[1]?.patch.last_error).toContain('invalid payload');
  });
});
