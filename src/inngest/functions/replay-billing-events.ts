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
  processed_status: 'failed' | null;
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

  // The replay-eligible set covers two cases:
  //   1. processed_status is null (handler never recorded a result — probably
  //      crashed mid-flight) AND the row is older than the cooldown so we
  //      know any in-flight Stripe-driven attempt has timed out.
  //   2. processed_status is 'failed' and last_attempted_at is null OR older
  //      than the cooldown — explicit failure, ready to retry.
  //
  // Two queries, merged and de-duplicated by id, keep the supabase-js filter
  // surface readable and easy to mock in tests.

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

  const merged = new Map<string, ReplayCandidate>();
  for (const row of [
    ...((nullStatusQuery.data ?? []) as ReplayCandidate[]),
    ...((failedNoAttemptQuery.data ?? []) as ReplayCandidate[]),
    ...((failedCooledQuery.data ?? []) as ReplayCandidate[]),
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
  const claim = await supabase
    .from('billing_events')
    .update({ last_attempted_at: now.toISOString() })
    .eq('id', row.id)
    .is('last_attempted_at', row.last_attempted_at)
    .select('id');

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
    await supabase
      .from('billing_events')
      .update({
        processed_status: 'failed',
        last_error: 'invalid payload (cannot reconstruct event)'.slice(0, LAST_ERROR_MAX),
      })
      .eq('id', row.id);
    return 'invalid_payload';
  }

  try {
    await handleStripeEvent(event, supabase, { previousStatus: 'failed' });
  } catch (handlerErr) {
    Sentry.captureException(handlerErr, {
      tags: { area: 'inngest.replay-billing-events' },
      extra: { billingEventId: row.id, stripe_event_id: row.stripe_event_id },
    });
    const message = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
    const safe = scrubString(message).slice(0, LAST_ERROR_MAX);
    await supabase
      .from('billing_events')
      .update({
        processed_status: 'failed',
        last_error: safe,
      })
      .eq('id', row.id);
    return 'failed';
  }

  await supabase
    .from('billing_events')
    .update({
      processed_at: now.toISOString(),
      processed_status: 'success',
      last_error: null,
    })
    .eq('id', row.id);
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
