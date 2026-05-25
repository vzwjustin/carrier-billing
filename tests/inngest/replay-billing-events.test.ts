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
  processReplayBatch,
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
 *      `replayBillingEvent` claims rows as in_flight, passes retry context, and
 *      writes the right bookkeeping.
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
  options: {
    /**
     * H3 — model the atomic CAS claim: a row is "stolen" if its current
     * `last_attempted_at` no longer matches the value the worker observed
     * during candidate selection. When `stolen` includes a row id, the
     * `.update().eq().is('last_attempted_at', X).select('id')` call on that
     * id returns 0 rows so the worker skips.
     */
    stolen?: Set<string>;
    /**
     * Throw when invoking the corresponding row id in step.run — used to
     * exercise the M-S3 sibling-row continuation guard. Throwing happens
     * inside `replayBillingEvent` (mocked via the handler) so we surface it
     * via the per-row try/catch in the cron loop.
     */
  } = {},
): SupabaseClient {
  const client = {
    from() {
      return {
        select() {
          return makeFilterableSelect(source, []);
        },
        update(patch: Record<string, unknown>) {
          // Direct `.update().eq().is(col, val).select(cols)` chain — used
          // by the H3 atomic claim. Falls back to the non-CAS path for the
          // success/failure bookkeeping updates that don't include `.is()`.
          const eqHandler = (col: string, val: unknown) => {
            const applyPatch = () => {
              const r = source.find((row) => row['id'] === val);
              if (r) {
                for (const [k, v] of Object.entries(patch)) {
                  r[k] = v;
                }
              }
            };
            // R1-F3: CAS chain now also filters on `processed_status` so a
            // `markSuccess` that flipped status without touching
            // `last_attempted_at` is no longer claimable. The chainable below
            // accepts any number of `.is()` / `.eq()` filters before `.select()`
            // terminates the CAS claim. Filter values are not checked against
            // the row state in this mock — the per-test `stolen` set remains
            // the override for "claim lost".
            const casChainable: {
              is: (c: string, v: unknown) => typeof casChainable;
              eq: (c: string, v: unknown) => typeof casChainable;
              select: (cols: string) => Promise<{
                data: Array<{ id: unknown }>;
                error: null;
              }>;
            } = {
              is(_c, _v) {
                return casChainable;
              },
              eq(_c, _v) {
                return casChainable;
              },
              select(_cols) {
                return Promise.resolve(
                  options.stolen && options.stolen.has(String(val))
                    ? { data: [] as Array<{ id: unknown }>, error: null }
                    : (() => {
                        updateLog.push({ patch, eq: [col, val] });
                        applyPatch();
                        return {
                          data: [{ id: val }] as Array<{ id: unknown }>,
                          error: null,
                        };
                      })(),
                );
              },
            };
            const directThenable: {
              then: (resolve: (v: { error: null }) => void) => void;
              is: (col2: string, val2: unknown) => typeof casChainable;
              eq: (col2: string, val2: unknown) => typeof casChainable;
            } = {
              then(resolve) {
                updateLog.push({ patch, eq: [col, val] });
                applyPatch();
                resolve({ error: null });
              },
              is(_col2, _val2) {
                return casChainable;
              },
              eq(_col2, _val2) {
                return casChainable;
              },
            };
            return directThenable;
          };
          return {
            eq: eqHandler,
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

  it('picks up stuck in_flight rows whose last_attempted_at has cooled (>60s)', async () => {
    // Webhook crashed AFTER markInFlight but BEFORE markSuccess/markFailure.
    // Row should still be reachable by the cron's stuck-claim recovery path.
    const source = [
      {
        id: 'be_in_flight_stuck',
        stripe_event_id: 'evt_stuck_in_flight',
        type: 't',
        payload: {},
        processed_status: 'in_flight',
        last_attempted_at: tsBefore(REPLAY_COOLDOWN_SECONDS + 30),
        created_at: tsBefore(120),
      },
    ];
    const candidates = await findReplayCandidates(makeSupabaseStub(source, []), NOW);
    expect(candidates.map((c) => c.id)).toEqual(['be_in_flight_stuck']);
  });

  it('does NOT pick up in_flight rows still inside the cooldown (worker presumed alive)', async () => {
    const source = [
      {
        id: 'be_in_flight_active',
        stripe_event_id: 'evt_active_in_flight',
        type: 't',
        payload: {},
        processed_status: 'in_flight',
        last_attempted_at: tsBefore(20), // worker is currently running
        created_at: tsBefore(120),
      },
    ];
    const candidates = await findReplayCandidates(makeSupabaseStub(source, []), NOW);
    expect(candidates).toEqual([]);
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

    // Two updates expected: claim in-flight + mark success.
    expect(updates).toHaveLength(2);
    expect(updates[0]?.patch).toEqual({
      processed_status: 'in_flight',
      last_attempted_at: NOW.toISOString(),
    });
    expect(updates[1]?.patch.processed_status).toBe('success');
    expect(updates[1]?.patch.processed_at).toBe(NOW.toISOString());
    expect(updates[1]?.patch.last_error).toBeNull();
  });

  it('passes row.processed_status as previousStatus + billingEventId to the handler (C1, C2)', async () => {
    const updates: Array<{ patch: Record<string, unknown>; eq: [string, unknown] }> = [];
    await replayBillingEvent(makeSupabaseStub([], updates), makeRow(VALID_PAYLOAD), NOW);
    expect(handleStripeEventMock).toHaveBeenCalledTimes(1);
    // C1: under the new model the replay cron passes the real prior
    // processed_status (instead of a hardcoded 'failed') and the
    // billing_events row id so handlers can use the atomic
    // grant_credit_once RPC. The makeRow factory defaults the row's
    // processed_status to 'failed', which is what we expect to see here.
    expect(handleStripeEventMock.mock.calls[0]?.[2]).toEqual({
      previousStatus: 'failed',
      billingEventId: 'be_target',
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

  // --- M-S3: sibling-row continuation on per-row error ---------------------

  it('M-S3: a thrown row does NOT cancel sibling rows in the batch', async () => {
    const rows: ReplayCandidate[] = [
      { id: 'row_a', stripe_event_id: 'evt_a', type: 't', payload: {}, processed_status: null, last_attempted_at: null },
      { id: 'row_bad', stripe_event_id: 'evt_bad', type: 't', payload: {}, processed_status: null, last_attempted_at: null },
      { id: 'row_c', stripe_event_id: 'evt_c', type: 't', payload: {}, processed_status: null, last_attempted_at: null },
    ];

    const seen: string[] = [];
    const tally = await processReplayBatch(rows, async (row) => {
      seen.push(row.id);
      if (row.id === 'row_bad') {
        throw new Error('boom mid-step');
      }
      return 'success';
    });

    // All three rows were attempted — the thrown row did not abort the loop.
    expect(seen).toEqual(['row_a', 'row_bad', 'row_c']);
    expect(tally.processed).toBe(3);
    expect(tally.successes).toBe(2);
    expect(tally.failures).toBe(1);
  });

  it('M-S3: outcome counters tally all four ReplayOutcome values', async () => {
    const rows: ReplayCandidate[] = [
      { id: 'r_ok', stripe_event_id: 'e1', type: 't', payload: {}, processed_status: null, last_attempted_at: null },
      { id: 'r_fail', stripe_event_id: 'e2', type: 't', payload: {}, processed_status: null, last_attempted_at: null },
      { id: 'r_inv', stripe_event_id: 'e3', type: 't', payload: {}, processed_status: null, last_attempted_at: null },
      { id: 'r_skip', stripe_event_id: 'e4', type: 't', payload: {}, processed_status: null, last_attempted_at: null },
    ];
    const outcomes: Record<string, 'success' | 'failed' | 'invalid_payload' | 'skipped'> = {
      r_ok: 'success',
      r_fail: 'failed',
      r_inv: 'invalid_payload',
      r_skip: 'skipped',
    };
    const tally = await processReplayBatch(rows, async (row) =>
      outcomes[row.id] ?? 'failed',
    );

    expect(tally).toEqual({
      processed: 4,
      successes: 1,
      failures: 1,
      invalid: 1,
      skipped: 1,
    });
  });

  // --- H3: atomic per-row claim --------------------------------------------

  it('H3: atomic claim returns 0 rows ⇒ skipped, handler is NOT invoked', async () => {
    // Simulate "another worker already moved last_attempted_at": the CAS
    // UPDATE on this row id matches 0 rows, so the worker bails out without
    // calling the Stripe handler.
    const updates: Array<{ patch: Record<string, unknown>; eq: [string, unknown] }> = [];
    const supabase = makeSupabaseStub([], updates, {
      stolen: new Set(['be_target']),
    });

    const outcome = await replayBillingEvent(
      supabase,
      makeRow(VALID_PAYLOAD),
      NOW,
    );

    expect(outcome).toBe('skipped');
    // Handler was NOT invoked — that's the whole point of the claim.
    expect(handleStripeEventMock).not.toHaveBeenCalled();
    // No bookkeeping update happened either (we never claimed the row).
    expect(updates).toHaveLength(0);
  });
});
