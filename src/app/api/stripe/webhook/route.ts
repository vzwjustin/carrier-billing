export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import * as Sentry from '@sentry/nextjs';
import type Stripe from 'stripe';
import { env } from '@/env';
import { getStripe } from '@/lib/stripe/client';
import { deriveUserIdFromEventObject } from '@/lib/stripe/events';
import { handleStripeEvent } from '@/lib/stripe/handlers';
import { getAdminClient } from '@/lib/supabase/admin';

interface BillingEventState {
  id: string;
  handled_at: string | null;
}

function isBillingEventState(value: unknown): value is BillingEventState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' && (v['handled_at'] === null || typeof v['handled_at'] === 'string')
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

function coerceBoolean(data: unknown): boolean {
  if (data === true) return true;
  if (Array.isArray(data)) {
    const first = data[0];
    if (first === true) return true;
    if (first && typeof first === 'object') {
      return (first as Record<string, unknown>)['claim_billing_event_for_handling'] === true;
    }
  }
  if (data && typeof data === 'object') {
    return (data as Record<string, unknown>)['claim_billing_event_for_handling'] === true;
  }
  return false;
}

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
    let shouldHandle = false;

    // Idempotency check. Only fully handled events dedupe. If a prior delivery
    // inserted the receipt but the handler failed before `handled_at` was set,
    // this delivery should retry the handler instead of permanently skipping it.
    const existing = await supabase
      .from('billing_events')
      .select('id,handled_at')
      .eq('stripe_event_id', event.id)
      .maybeSingle();

    if (existing.error) {
      Sentry.captureException(existing.error, {
        tags: { area: 'stripe.webhook.lookup', stripe_event_type: event.type },
        extra: { stripe_event_id: event.id },
      });
      return new Response('Internal error', { status: 500 });
    }

    if (existing.data) {
      if (!isBillingEventState(existing.data)) {
        Sentry.captureMessage('stripe webhook billing event row had bad shape', {
          level: 'error',
          extra: { stripe_event_id: event.id },
        });
        return new Response('Internal error', { status: 500 });
      }
      if (existing.data.handled_at) {
        console.log('[stripe.webhook]', event.type, event.id, 'deduped');
        return Response.json({ received: true, deduped: true });
      }
      const claim = await supabase.rpc('claim_billing_event_for_handling', {
        p_stripe_event_id: event.id,
        p_stale_before: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });
      if (claim.error) {
        Sentry.captureException(claim.error, {
          tags: { area: 'stripe.webhook.claim', stripe_event_type: event.type },
          extra: { stripe_event_id: event.id },
        });
        return new Response('Internal error', { status: 500 });
      }
      shouldHandle = coerceBoolean(claim.data);
    } else {
      const userId = deriveUserIdFromEventObject(event.data.object);

      const now = new Date().toISOString();
      const insertResult = await supabase.from('billing_events').insert({
        stripe_event_id: event.id,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
        user_id: userId,
        processing_started_at: now,
        handler_error: null,
      });

      if (insertResult.error) {
        const code = (insertResult.error as { code?: string }).code;
        if (code === '23505') {
          const raced = await supabase
            .from('billing_events')
            .select('id,handled_at')
            .eq('stripe_event_id', event.id)
            .maybeSingle();

          if (raced.error || !raced.data || !isBillingEventState(raced.data)) {
            Sentry.captureException(raced.error ?? insertResult.error, {
              tags: {
                area: 'stripe.webhook.insert_race',
                stripe_event_type: event.type,
              },
              extra: { stripe_event_id: event.id },
            });
            return new Response('Internal error', { status: 500 });
          }
          if (raced.data.handled_at) {
            console.log('[stripe.webhook]', event.type, event.id, 'deduped');
            return Response.json({ received: true, deduped: true });
          }
          const claim = await supabase.rpc('claim_billing_event_for_handling', {
            p_stripe_event_id: event.id,
            p_stale_before: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          });
          if (claim.error) {
            Sentry.captureException(claim.error, {
              tags: {
                area: 'stripe.webhook.claim_race',
                stripe_event_type: event.type,
              },
              extra: { stripe_event_id: event.id },
            });
            return new Response('Internal error', { status: 500 });
          }
          shouldHandle = coerceBoolean(claim.data);
        } else {
          console.error('[stripe.webhook] insert failed', event.type, event.id, insertResult.error);
          Sentry.captureException(insertResult.error, {
            tags: { area: 'stripe.webhook', stripe_event_type: event.type },
            extra: { stripe_event_id: event.id },
          });
          return new Response('Internal error', { status: 500 });
        }
      } else {
        shouldHandle = true;
      }
    }

    if (!shouldHandle) {
      console.log('[stripe.webhook]', event.type, event.id, 'already processing');
      return new Response('Event is already processing', { status: 500 });
    }

    console.log('[stripe.webhook]', event.type, event.id);

    try {
      await handleStripeEvent(event, supabase);
    } catch (handlerErr) {
      console.error('[stripe.webhook] handler failed', event.type, event.id, handlerErr);
      Sentry.captureException(handlerErr, {
        tags: { area: 'stripe.webhook.handler', stripe_event_type: event.type },
        extra: { stripe_event_id: event.id },
      });
      const markFailed = await supabase
        .from('billing_events')
        .update({
          handler_error: errorMessage(handlerErr).slice(0, 1000),
          handled_at: null,
          processing_started_at: null,
        })
        .eq('stripe_event_id', event.id);
      if (markFailed.error) {
        Sentry.captureException(markFailed.error, {
          tags: {
            area: 'stripe.webhook.mark_failed',
            stripe_event_type: event.type,
          },
          extra: { stripe_event_id: event.id },
        });
      }
      return new Response('Internal error', { status: 500 });
    }

    const markHandled = await supabase
      .from('billing_events')
      .update({
        handled_at: new Date().toISOString(),
        processing_started_at: null,
        handler_error: null,
      })
      .eq('stripe_event_id', event.id);
    if (markHandled.error) {
      Sentry.captureException(markHandled.error, {
        tags: { area: 'stripe.webhook.mark_handled', stripe_event_type: event.type },
        extra: { stripe_event_id: event.id },
      });
      return new Response('Internal error', { status: 500 });
    }

    return Response.json({ received: true });
  } catch (err) {
    console.error('[stripe.webhook] unexpected error', err);
    Sentry.captureException(err, { tags: { area: 'stripe.webhook' } });
    return new Response('Internal error', { status: 500 });
  }
}
