export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import * as Sentry from '@sentry/nextjs';
import type Stripe from 'stripe';
import { env } from '@/env';
import { getStripe } from '@/lib/stripe/client';
import { deriveUserIdFromEventObject } from '@/lib/stripe/events';
import { handleStripeEvent } from '@/lib/stripe/handlers';
import { getAdminClient } from '@/lib/supabase/admin';

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
      event = getStripe().webhooks.constructEvent(
        rawBody,
        signature,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      return new Response('Invalid signature', { status: 400 });
    }

    const supabase = getAdminClient();

    // Idempotency check — if we've already persisted this event, ack and exit.
    // The unique constraint on `stripe_event_id` is the ultimate guarantee,
    // but checking first lets us return a friendly `deduped` flag and avoid
    // a write on retries.
    const existing = await supabase
      .from('billing_events')
      .select('id')
      .eq('stripe_event_id', event.id)
      .maybeSingle();

    if (existing.data) {
      console.log('[stripe.webhook]', event.type, event.id, 'deduped');
      return Response.json({ received: true, deduped: true });
    }

    const userId = deriveUserIdFromEventObject(event.data.object);

    const insertResult = await supabase.from('billing_events').insert({
      stripe_event_id: event.id,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
      user_id: userId,
    });

    if (insertResult.error) {
      // If the unique constraint tripped concurrently, treat as deduped.
      // Postgres unique violation is SQLSTATE 23505; supabase-js surfaces it
      // via `code`. Anything else is unexpected.
      const code = (insertResult.error as { code?: string }).code;
      if (code === '23505') {
        console.log('[stripe.webhook]', event.type, event.id, 'deduped');
        return Response.json({ received: true, deduped: true });
      }
      console.error(
        '[stripe.webhook] insert failed',
        event.type,
        event.id,
        insertResult.error,
      );
      // We catch + return manually here, so Next's onRequestError hook never
      // fires. Capture explicitly so the failure shows up in Sentry.
      Sentry.captureException(insertResult.error, {
        tags: { area: 'stripe.webhook', stripe_event_type: event.type },
        extra: { stripe_event_id: event.id },
      });
      return new Response('Internal error', { status: 500 });
    }

    console.log('[stripe.webhook]', event.type, event.id);

    // Phase 4: branch on event.type to mutate profiles. The event row has
    // already been persisted, so if the handler throws we capture to Sentry
    // and still ack the webhook — Stripe will not retry, but we can replay
    // from `billing_events` later. (Alternative: return 500 to force a Stripe
    // retry. We prefer ack-and-replay because Stripe's retry budget is
    // limited and we'd rather repair manually than lose visibility.)
    try {
      await handleStripeEvent(event, supabase);
    } catch (handlerErr) {
      console.error(
        '[stripe.webhook] handler failed',
        event.type,
        event.id,
        handlerErr,
      );
      Sentry.captureException(handlerErr, {
        tags: { area: 'stripe.webhook.handler', stripe_event_type: event.type },
        extra: { stripe_event_id: event.id },
      });
    }

    return Response.json({ received: true });
  } catch (err) {
    console.error('[stripe.webhook] unexpected error', err);
    Sentry.captureException(err, { tags: { area: 'stripe.webhook' } });
    return new Response('Internal error', { status: 500 });
  }
}
