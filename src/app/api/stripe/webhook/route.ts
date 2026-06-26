export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import * as Sentry from '@sentry/nextjs';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/env';
import { scrubString } from '@/lib/observability/redact';
import { getStripe } from '@/lib/stripe/client';
import { deriveUserIdFromEventObject } from '@/lib/stripe/events';
import { handleStripeEvent } from '@/lib/stripe/handlers';
import { getAdminClient } from '@/lib/supabase/admin';

const LAST_ERROR_MAX = 500;

type ProcessedStatus = 'success' | 'failed' | 'in_flight' | null;

type BillingEventRow = {
  id: string;
  processed_status: ProcessedStatus;
};

export async function POST(request: Request): Promise<Response> {
  try {
    const signature = request.headers.get('stripe-signature');
    if (!signature) {
      return new Response('Invalid signature', { status: 400 });
    }

    // Stripe requires the raw, unparsed body to verify the signature.
    const rawBody = await request.text();

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return new Response('Invalid signature', { status: 400 });
    }

    const supabase = getAdminClient();

    // ---- billing_events row reconciliation -------------------------------
    //
    // Insert if first sighting, fetch if a prior request already inserted.
    // The unique constraint on `stripe_event_id` is the durable dedupe; the
    // pre-check + 23505 fallback below just narrows the path so we never
    // hit a wasted INSERT on a hot retry.

    const existing = await supabase
      .from('billing_events')
      .select('id, processed_status')
      .eq('stripe_event_id', event.id)
      .maybeSingle();

    let billingEventId: string;
    let previousStatus: ProcessedStatus;

    if (existing.data) {
      const row = existing.data as BillingEventRow;
      if (row.processed_status === 'success' || row.processed_status === 'in_flight') {
        // H8: already-processed → idempotent ack.
        // R1-F2: in_flight → another worker is mid-handler right now. Dedupe
        // at the entry path so we don't invoke handleStripeEvent in parallel.
        // Some handler side effects (subscription_status writes, past_due
        // flip, inngest.send) are not gated by previousStatus and would
        // otherwise fire twice. The CAS in markInFlight is the durable
        // backstop; this is the entry-time fast path.
        console.log('[stripe.webhook]', event.type, event.id, 'deduped');
        return Response.json({ received: true, deduped: true });
      }
      billingEventId = row.id;
      previousStatus = row.processed_status;
    } else {
      const userId = deriveUserIdFromEventObject(event.data.object);
      const insertResult = await supabase
        .from('billing_events')
        .insert({
          stripe_event_id: event.id,
          type: event.type,
          payload: event as unknown as Record<string, unknown>,
          user_id: userId,
        })
        .select('id, processed_status')
        .maybeSingle();

      if (insertResult.error) {
        const code = (insertResult.error as { code?: string }).code;
        if (code === '23505') {
          // A concurrent request beat us to it. Re-fetch the winning row.
          const raced = await supabase
            .from('billing_events')
            .select('id, processed_status')
            .eq('stripe_event_id', event.id)
            .maybeSingle();
          if (!raced.data) {
            console.error('[stripe.webhook] race fetch failed', event.type, event.id);
            Sentry.captureException(new Error('race fetch returned no row after 23505'), {
              tags: { area: 'stripe.webhook', stripe_event_type: event.type },
              extra: { stripe_event_id: event.id },
            });
            return new Response('Internal error', { status: 500 });
          }
          const row = raced.data as BillingEventRow;
          if (row.processed_status === 'success' || row.processed_status === 'in_flight') {
            // R1-F2 — same dedupe as the existing-row path above.
            console.log('[stripe.webhook]', event.type, event.id, 'deduped');
            return Response.json({ received: true, deduped: true });
          }
          billingEventId = row.id;
          previousStatus = row.processed_status;
        } else {
          console.error(
            '[stripe.webhook] insert failed',
            event.type,
            event.id,
            scrubString(
              insertResult.error instanceof Error
                ? insertResult.error.message
                : String(insertResult.error),
            ),
          );
          Sentry.captureException(insertResult.error, {
            tags: { area: 'stripe.webhook', stripe_event_type: event.type },
            extra: { stripe_event_id: event.id },
          });
          return new Response('Internal error', { status: 500 });
        }
      } else {
        if (!insertResult.data) {
          console.error('[stripe.webhook] insert returned no row', event.type, event.id);
          return new Response('Internal error', { status: 500 });
        }
        const row = insertResult.data as BillingEventRow;
        billingEventId = row.id;
        previousStatus = row.processed_status; // null for fresh inserts
      }
    }

    console.log('[stripe.webhook]', event.type, event.id);

    // ---- handler invocation + state recording ----------------------------
    //
    // H8: previously this catch swallowed handler errors and returned 200 so
    // Stripe wouldn't retry. We now re-throw a 5xx so Stripe DOES retry. The
    // per-handler effects MUST be safe to re-run — the credit grant in
    // checkout.session.completed gates on `previousStatus` for that reason.
    //
    // M-1+M-2: set processed_status='in_flight' BEFORE invoking the handler so
    // any concurrent attempt (replay cron or duplicate Stripe delivery) sees a
    // non-null previousStatus and short-circuits non-idempotent ops (credit
    // grant). R1-F1: this is now a true CAS — the UPDATE only matches when
    // processed_status is still null or 'failed'. A concurrent worker that
    // already claimed the row (e.g. the 23505-loser of a brand-new INSERT
    // race) gets `'lost'` back and short-circuits BEFORE invoking the handler
    // so the credit grant in checkout.session.completed cannot fire twice.
    const claim = await markInFlight(supabase, billingEventId);
    if (claim === 'error') {
      return new Response('Bookkeeping failed', { status: 500 });
    }
    if (claim === 'lost') {
      console.log('[stripe.webhook]', event.type, event.id, 'claim lost, deduped');
      return Response.json({ received: true, deduped: true });
    }

    try {
      await handleStripeEvent(event, supabase, {
        previousStatus,
        billingEventId,
      });
    } catch (handlerErr) {
      console.error(
        '[stripe.webhook] handler failed',
        event.type,
        event.id,
        scrubString(handlerErr instanceof Error ? handlerErr.message : String(handlerErr)),
      );
      Sentry.captureException(handlerErr, {
        tags: { area: 'stripe.webhook.handler', stripe_event_type: event.type },
        extra: { stripe_event_id: event.id },
      });
      await markFailure(supabase, billingEventId, handlerErr);
      return new Response('Handler failed', { status: 500 });
    }

    // M-S1: if the bookkeeping update fails after the handler succeeded, we
    // must NOT return 200 — that leaves the row with `processed_status=null`
    // and the replay cron would re-invoke the handler with previousStatus=null,
    // which would re-grant credits / re-flip status. Returning 5xx makes
    // Stripe retry; on the retry the existing row is found, previousStatus
    // is read from the row (still null OR whatever the next bookkeeping
    // attempt sets). Checkout credit grants are idempotent through
    // `grant_credit_once`, keyed by billingEventId, so retrying after this
    // bookkeeping failure can safely converge.
    const markErr = await markSuccess(supabase, billingEventId);
    if (markErr) {
      return new Response('Bookkeeping failed', { status: 500 });
    }
    return Response.json({ received: true });
  } catch (err) {
    console.error(
      '[stripe.webhook] unexpected error',
      scrubString(err instanceof Error ? err.message : String(err)),
    );
    Sentry.captureException(err, { tags: { area: 'stripe.webhook' } });
    return new Response('Internal error', { status: 500 });
  }
}

async function markInFlight(
  supabase: SupabaseClient,
  billingEventId: string,
): Promise<'claimed' | 'lost' | 'error'> {
  // R1-F1 — true CAS claim. The UPDATE matches only when processed_status is
  // still null (fresh insert) or 'failed' (retry of a prior failure). If
  // another worker already flipped the row to 'in_flight' or 'success', the
  // UPDATE matches zero rows and we return 'lost' so the caller short-circuits
  // BEFORE invoking the handler. This closes the window between INSERT and the
  // first markInFlight where two concurrent webhook deliveries could otherwise
  // both observe previousStatus=null and both fire the credit grant.
  try {
    const { data, error } = await supabase
      .from('billing_events')
      .update({
        processed_status: 'in_flight',
        last_attempted_at: new Date().toISOString(),
      })
      .eq('id', billingEventId)
      .or('processed_status.is.null,processed_status.eq.failed')
      .select('id');
    if (error) {
      Sentry.captureException(error, {
        tags: { area: 'stripe.webhook.mark_in_flight' },
        extra: { billingEventId },
      });
      // Err on the safe side: a transient DB error here is indistinguishable
      // from a lost claim unless we surface it separately. Return 'error' so
      // the handler does not run and Stripe retries the delivery with a 5xx.
      return 'error';
    }
    const rows = (data ?? []) as Array<{ id: string }>;
    return rows.length > 0 ? 'claimed' : 'lost';
  } catch (markErr) {
    Sentry.captureException(markErr, {
      tags: { area: 'stripe.webhook.mark_in_flight' },
      extra: { billingEventId },
    });
    return 'error';
  }
}

async function markSuccess(
  supabase: SupabaseClient,
  billingEventId: string,
): Promise<unknown | null> {
  const { data, error } = await supabase
    .from('billing_events')
    .update({
      processed_at: new Date().toISOString(),
      processed_status: 'success',
      last_error: null,
    })
    .eq('id', billingEventId)
    .select('id');
  if (error) {
    // M-S1: surface to Sentry AND return the error so the caller can 5xx and
    // let Stripe retry. Returning 200 would leave the row stuck at null and
    // the replay cron would re-process the handler.
    Sentry.captureException(error, {
      tags: { area: 'stripe.webhook.mark_success' },
      extra: { billingEventId },
    });
    return error;
  }
  const rows = (data ?? []) as Array<{ id: string }>;
  if (rows.length !== 1) {
    const rowCountErr = new Error(`markSuccess matched ${rows.length} billing_events rows`);
    Sentry.captureException(rowCountErr, {
      tags: { area: 'stripe.webhook.mark_success' },
      extra: { billingEventId, matchCount: rows.length },
    });
    return rowCountErr;
  }
  return null;
}

async function markFailure(
  supabase: SupabaseClient,
  billingEventId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const safe = scrubString(message).slice(0, LAST_ERROR_MAX);
  // M1: CAS-gate the demotion on processed_status='in_flight' — the state
  // markInFlight claimed before the handler ran. Without it a plain UPDATE
  // WHERE id could demote a terminal 'success' row (one a concurrent replay-cron
  // tick or duplicate delivery already finalized) back to 'failed', which the
  // replay cron's (null|failed) claim then re-picks → handler re-runs →
  // unprotected inngest.send + subscription writes re-fire. 0 rows here now
  // means the row already reached a terminal state concurrently — a benign
  // no-op, not an error.
  const { data, error } = await supabase
    .from('billing_events')
    .update({
      processed_status: 'failed',
      last_error: safe,
    })
    .eq('id', billingEventId)
    .eq('processed_status', 'in_flight')
    .select('id');
  if (error) {
    Sentry.captureException(error, {
      tags: { area: 'stripe.webhook.mark_failure' },
      extra: { billingEventId },
    });
    return;
  }
  const rows = (data ?? []) as Array<{ id: string }>;
  if (rows.length > 1) {
    Sentry.captureMessage('stripe webhook markFailure matched unexpected row count', {
      level: 'error',
      tags: { area: 'stripe.webhook.mark_failure' },
      extra: { billingEventId, matchCount: rows.length },
    });
  }
}
