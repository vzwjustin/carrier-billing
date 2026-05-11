import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import { inngest } from '../client';
import { scrubString } from '@/lib/observability/redact';
import { handleStripeEvent } from '@/lib/stripe/handlers';
import { getAdminClient } from '@/lib/supabase/admin';

/**
 * H8 — replay-billing-events.
 *
 * Out-of-band recovery for Stripe webhook events whose handler invocation
 * never completed. The webhook route now returns 5xx on handler failure so
 * Stripe will retry, but Stripe's retry budget is finite (and Stripe never
 * retries when the handler itself was OK and the failure was downstream of
 * our 200 ack). This cron is the safety net.
 *
 * Selection predicate (mirrored in `0008_stripe_webhook_hardening.sql`'s
 * partial index):
 *   - `processed_status IS NULL OR processed_status = 'failed'`
 *   - within the last 24 hours (older rows are reconciled manually)
 *   - not attempted in the last 60 seconds (cooldown so we don't race
 *     Stripe's own delivery retry)
 *
 * Handler invocations from this cron always pass `previousStatus = 'failed'`
 * so non-idempotent operations (the credit grant) skip on retry. See the
 * tradeoff comment in `handlers.ts:onCheckoutSessionCompleted`.
 */

export const REPLAY_LOOKBACK_HOURS = 24;
export const REPLAY_COOLDOWN_SECONDS = 60;
export const REPLAY_BATCH_LIMIT = 50;
const LAST_ERROR_MAX = 500;

export type ReplayCandidate = {
  id: string;
  stripe_event_id: string;
  type: string;
  payload: unknown;
  // 'in_flight' included so the cron can recover rows where the webhook
  // crashed AFTER markInFlight but BEFORE markSuccess/markFailure. Stripe's
  // own retry budget (~13 attempts over ~3 days) is the primary recovery
  // path; the cron is the safety net for rows still stuck after Stripe
  // gives up.
  processed_status: 'failed' | 'in_flight' | null;
  last_attempted_at: string | null;
};

/**
 * Find rows the cron should attempt this tick. Exported for testing.
 */
export async function findReplayCandidates(
  supabase: SupabaseClient,
  now: Date,
): Promise<ReplayCandidate[]> {
  const lookbackCutoff = new Date(
    now.getTime() - REPLAY_LOOKBACK_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const cooldownCutoff = new Date(
    now.getTime() - REPLAY_COOLDOWN_SECONDS * 1000,
  ).toISOString();

  // The replay-eligible set covers three cases:
  //   1. processed_status is null (handler never recorded a result — probably
  //      crashed mid-flight) AND the row is older than the cooldown so we
  //      know any in-flight Stripe-driven attempt has timed out.
  //   2. processed_status is 'failed' and last_attempted_at is null OR older
  //      than the cooldown — explicit failure, ready to retry.
  //   3. processed_status is 'in_flight' AND last_attempted_at is older than
  //      the cooldown — webhook crashed mid-handler. Stripe's retry budget
  //      handles the normal recovery; this query is the safety net for rows
  //      still stuck after Stripe gives up. The 0014 partial index excludes
  //      in_flight rows, so this query does a small filtered scan instead.
  //
  // Queries are merged and de-duplicated by id; per-query filter surface
  // stays small and easy to mock in tests.

  const nullStatusQuery = await supabase
    .from('billing_events')
    .select('id, stripe_event_id, type, payload, processed_status, last_attempted_at')
    .is('processed_status', null)
    .gte('created_at', lookbackCutoff)
    .lte('created_at', cooldownCutoff)
    .order('created_at', { ascending: true })
    .limit(REPLAY_BATCH_LIMIT);

  if (nullStatusQuery.error) {
    throw new Error(
      `replay candidate select (null) failed: ${nullStatusQuery.error.message}`,
    );
  }

  const failedNoAttemptQuery = await supabase
    .from('billing_events')
    .select('id, stripe_event_id, type, payload, processed_status, last_attempted_at')
    .eq('processed_status', 'failed')
    .gte('created_at', lookbackCutoff)
    .is('last_attempted_at', null)
    .order('created_at', { ascending: true })
    .limit(REPLAY_BATCH_LIMIT);

  if (failedNoAttemptQuery.error) {
    throw new Error(
      `replay candidate select (failed, never attempted) failed: ${failedNoAttemptQuery.error.message}`,
    );
  }

  const failedCooledQuery = await supabase
    .from('billing_events')
    .select('id, stripe_event_id, type, payload, processed_status, last_attempted_at')
    .eq('processed_status', 'failed')
    .gte('created_at', lookbackCutoff)
    .lte('last_attempted_at', cooldownCutoff)
    .order('created_at', { ascending: true })
    .limit(REPLAY_BATCH_LIMIT);

  if (failedCooledQuery.error) {
    throw new Error(
      `replay candidate select (failed, cooled) failed: ${failedCooledQuery.error.message}`,
    );
  }

  // Stuck in_flight recovery: rows where the webhook set 'in_flight' but
  // never reached 'success' or 'failed'. last_attempted_at past cooldown
  // means the in-flight worker is presumed dead. The CAS claim in
  // replayBillingEvent guards against concurrent recovery.
  const stuckInFlightQuery = await supabase
    .from('billing_events')
    .select('id, stripe_event_id, type, payload, processed_status, last_attempted_at')
    .eq('processed_status', 'in_flight')
    .gte('created_at', lookbackCutoff)
    .lte('last_attempted_at', cooldownCutoff)
    .order('created_at', { ascending: true })
    .limit(REPLAY_BATCH_LIMIT);

  if (stuckInFlightQuery.error) {
    throw new Error(
      `replay candidate select (in_flight, stuck) failed: ${stuckInFlightQuery.error.message}`,
    );
  }

  const merged = new Map<string, ReplayCandidate>();
  for (const row of [
    ...((nullStatusQuery.data ?? []) as ReplayCandidate[]),
    ...((failedNoAttemptQuery.data ?? []) as ReplayCandidate[]),
    ...((failedCooledQuery.data ?? []) as ReplayCandidate[]),
    ...((stuckInFlightQuery.data ?? []) as ReplayCandidate[]),
  ]) {
    if (!merged.has(row.id)) merged.set(row.id, row);
  }
  return Array.from(merged.values()).slice(0, REPLAY_BATCH_LIMIT);
}

export type ReplayOutcome = 'success' | 'failed' | 'invalid_payload' | 'skipped';

/**
 * Replay a single billing_events row. Exported for testing.
 *
 * Always treats the invocation as a retry (`previousStatus = 'failed'`) so
 * non-idempotent ops in handlers short-circuit. See the credit-grant
 * tradeoff comment in `handlers.ts`.
 */
export async function replayBillingEvent(
  supabase: SupabaseClient,
  row: ReplayCandidate,
  now: Date,
): Promise<ReplayOutcome> {
  // H3 — atomic claim (compare-and-swap on `last_attempted_at`).
  //
  // Two cron ticks (or a tick racing with a Stripe redelivery in flight)
  // can both pick the same row with `findReplayCandidates`. Without a CAS
  // claim, both would call the handler concurrently. We make the
  // `last_attempted_at` UPDATE conditional on the value we observed during
  // the candidate select: if another worker already moved the timestamp,
  // our UPDATE matches 0 rows and we skip without invoking the handler.
  // `.select('id')` lets us read the row count.
  //
  // R1-F3 — also CAS on processed_status. `markSuccess` in the webhook route
  // flips processed_status without touching last_attempted_at, so a row that
  // the webhook completed AFTER our SELECT can still pass the timestamp CAS.
  // previousStatus='failed' (below) protects the credit grant, but other
  // handler side effects (subscription_status writes, past_due flip,
  // inngest.send) would otherwise fire twice. CAS-on-status closes that.
  const claimBase = supabase
    .from('billing_events')
    .update({ last_attempted_at: now.toISOString() })
    .eq('id', row.id)
    .is('last_attempted_at', row.last_attempted_at);
  const claimWithStatus =
    row.processed_status === null
      ? claimBase.is('processed_status', null)
      : claimBase.eq('processed_status', row.processed_status);
  const claim = await claimWithStatus.select('id');

  const claimedRows = (claim.data ?? []) as Array<{ id: string }>;
  if (claimedRows.length === 0) {
    Sentry.addBreadcrumb({
      category: 'inngest',
      message: 'replay-billing-events: row claim lost (concurrent worker)',
      level: 'info',
      data: { billingEventId: row.id, stripe_event_id: row.stripe_event_id },
    });
    return 'skipped';
  }

  // Reconstitute the Stripe.Event from the persisted payload. The webhook
  // route stored the verified event verbatim, so it's safe to trust here.
  const event = row.payload as Stripe.Event | null;
  if (!event || typeof event !== 'object' || event.type !== row.type) {
    Sentry.captureMessage('replay-billing-events: invalid payload, marking failed', {
      level: 'error',
      extra: { billingEventId: row.id, stripe_event_id: row.stripe_event_id },
    });
    // C2: surface bookkeeping write failures. Silently swallowing here meant
    // a flapping DB would leave the row at its original processed_status, so
    // the cron would re-claim it every 15 min forever (and re-invoke the
    // handler when the row's status is recoverable). Throw on update error
    // so Inngest retries the step.
    const { error: markErr } = await supabase
      .from('billing_events')
      .update({
        processed_status: 'failed',
        last_error: 'invalid payload (cannot reconstruct event)'.slice(0, LAST_ERROR_MAX),
      })
      .eq('id', row.id);
    if (markErr) {
      throw new Error(
        `replay-billing-events: bookkeeping (invalid_payload) update failed: ${markErr.message}`,
      );
    }
    return 'invalid_payload';
  }

  try {
    await handleStripeEvent(event, supabase, {
      previousStatus: row.processed_status === null ? 'failed' : row.processed_status,
      billingEventId: row.id,
    });
  } catch (handlerErr) {
    Sentry.captureException(handlerErr, {
      tags: { area: 'inngest.replay-billing-events' },
      extra: { billingEventId: row.id, stripe_event_id: row.stripe_event_id },
    });
    const message = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
    const safe = scrubString(message).slice(0, LAST_ERROR_MAX);
    // C2: same — must not swallow bookkeeping errors.
    const { error: markErr } = await supabase
      .from('billing_events')
      .update({
        processed_status: 'failed',
        last_error: safe,
      })
      .eq('id', row.id);
    if (markErr) {
      throw new Error(
        `replay-billing-events: bookkeeping (failed) update failed: ${markErr.message}`,
      );
    }
    return 'failed';
  }

  // C2: success bookkeeping. Previously this was the most dangerous swallow —
  // a failure here left the row at 'failed' or 'in_flight' while reporting
  // 'success' to the caller, causing the next cron tick to re-run the handler
  // (re-firing non-idempotent side effects like subscription_status writes
  // and inngest.send).
  const { error: successErr } = await supabase
    .from('billing_events')
    .update({
      processed_at: now.toISOString(),
      processed_status: 'success',
      last_error: null,
    })
    .eq('id', row.id);
  if (successErr) {
    throw new Error(
      `replay-billing-events: bookkeeping (success) update failed: ${successErr.message}`,
    );
  }
  return 'success';
}

/**
 * Counters returned by `processReplayBatch`.
 */
export type ReplayBatchTally = {
  processed: number;
  successes: number;
  failures: number;
  invalid: number;
  skipped: number;
};

/**
 * Process a batch of replay candidates.
 *
 * `runOne` is the per-row invocation wrapper — in production this is a
 * `step.run(name, fn)` call so the Inngest framework persists each row's
 * outcome durably. In tests we pass a plain async function so the loop's
 * sibling-row continuation behavior can be exercised without booting Inngest.
 *
 * M-S3: per-row try/catch ensures one bad row does not cancel siblings (a
 * thrown step.run would otherwise abort the whole batch). The loop is
 * sequential because Stripe deliveries for the same customer are
 * order-sensitive — concurrency would risk applying patches out of order.
 */
export async function processReplayBatch(
  candidates: ReplayCandidate[],
  runOne: (row: ReplayCandidate) => Promise<ReplayOutcome>,
): Promise<ReplayBatchTally> {
  let successes = 0;
  let failures = 0;
  let invalid = 0;
  let skipped = 0;

  for (const row of candidates) {
    try {
      const outcome = await runOne(row);
      if (outcome === 'success') successes += 1;
      else if (outcome === 'invalid_payload') invalid += 1;
      else if (outcome === 'skipped') skipped += 1;
      else failures += 1;
    } catch (rowErr) {
      // Per-row failure must not abort the batch.
      Sentry.captureException(rowErr, {
        tags: { area: 'inngest.replay-billing-events.batch' },
        extra: { eventId: row.id },
      });
      failures += 1;
    }
  }

  return { processed: candidates.length, successes, failures, invalid, skipped };
}

export const replayBillingEventsFn = inngest.createFunction(
  { id: 'replay-billing-events', retries: 1 },
  { cron: '*/15 * * * *' },
  async ({ step, logger }) => {
    const candidates = (await step.run('find-candidates', async () => {
      const supabase = getAdminClient();
      const rows = await findReplayCandidates(supabase, new Date());
      return rows;
    })) as ReplayCandidate[];

    logger.info('replay-billing-events: found candidates', {
      count: candidates.length,
    });

    const tally = await processReplayBatch(candidates, async (row) => {
      return (await step.run(`replay-${row.id}`, async () => {
        const supabase = getAdminClient();
        return replayBillingEvent(supabase, row, new Date());
      })) as ReplayOutcome;
    });

    logger.info('replay-billing-events: done', tally);

    return tally;
  },
);
