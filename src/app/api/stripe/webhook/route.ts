export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type Stripe from 'stripe';
import { env } from '@/env';
import { getStripe } from '@/lib/stripe/client';
import { deriveUserIdFromEventObject } from '@/lib/stripe/events';
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
      return new Response('Internal error', { status: 500 });
    }

    // Phase 0: just observe. Phase 4 will branch on event.type to mutate
    // profiles.audit_credits / subscription_status here.
    console.log('[stripe.webhook]', event.type, event.id);

    return Response.json({ received: true });
  } catch (err) {
    console.error('[stripe.webhook] unexpected error', err);
    return new Response('Internal error', { status: 500 });
  }
}
