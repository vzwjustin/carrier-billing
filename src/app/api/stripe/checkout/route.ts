export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { env } from '@/env';
import { scrubString } from '@/lib/observability/redact';
import { getStripe } from '@/lib/stripe/client';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const BodySchema = z.object({
  mode: z.enum(['one_time', 'subscription']),
});

/**
 * Create a Stripe Checkout session for the authenticated user.
 *
 * - Validates body with zod (`mode: 'one_time' | 'subscription'`).
 * - Looks up the caller's profile via the service-role client. If they don't
 *   yet have a Stripe customer, we create one and persist the id.
 * - Builds a Checkout session keyed to the configured price id and redirects
 *   the client to Stripe's hosted page.
 *
 * Idempotency: Stripe sessions are themselves transient — retrying the request
 * just creates another session. The state-changing event (purchase) is handled
 * by the webhook, which is gated by `billing_events.stripe_event_id`.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid_body' }, { status: 400 });
    }

    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: 'invalid_mode', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { mode } = parsed.data;

    const admin = getAdminClient();

    // Pull the profile for the authenticated user. We use the service role so
    // we can also update `stripe_customer_id` if missing.
    const profileResult = await admin
      .from('profiles')
      .select('id, stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle();

    if (profileResult.error) {
      throw new Error(
        `profile lookup failed: ${profileResult.error.message}`,
      );
    }

    const profile = profileResult.data as {
      id: string;
      stripe_customer_id: string | null;
    } | null;

    if (!profile) {
      return Response.json({ error: 'profile_missing' }, { status: 400 });
    }

    const stripe = getStripe();

    let stripeCustomerId = profile.stripe_customer_id;
    if (!stripeCustomerId) {
      // B6 — concurrent first-time-checkout race.
      //
      // Two simultaneous requests that both saw `stripe_customer_id` as null
      // would each call `customers.create` and then race to write the id back.
      // Without coordination, the second update silently overwrites the first
      // and leaves an orphaned Stripe customer on the account.
      //
      // Fix: only the first writer wins via the `.is('stripe_customer_id', null)`
      // guard on UPDATE. We ask Postgres to return the affected row id so we
      // can detect the 0-row case (someone else already wrote a customer id);
      // when that happens, re-fetch the profile to learn the winner and DELETE
      // the orphaned customer we just created.
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { userId: user.id },
      });

      const updateResult = await admin
        .from('profiles')
        .update({
          stripe_customer_id: customer.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', user.id)
        .is('stripe_customer_id', null)
        .select('id');

      if (updateResult.error) {
        // Best-effort cleanup of the new customer before surfacing the failure.
        try {
          await stripe.customers.del(customer.id);
        } catch (cleanupErr) {
          // M-S2: Stripe error messages can echo customer email/address.
          // Scrub the message string before handing it to Sentry's serializer
          // (extra is id-only and safe).
          Sentry.captureException(
            new Error(scrubString(String(cleanupErr))),
            {
              tags: { area: 'stripe.checkout.cleanup' },
              extra: { customerId: customer.id, userId: user.id },
            },
          );
        }
        throw new Error(
          `persist stripe_customer_id failed: ${updateResult.error.message}`,
        );
      }

      const rows = (updateResult.data ?? []) as Array<{ id: string }>;
      if (rows.length === 1) {
        // We won the race.
        stripeCustomerId = customer.id;
      } else {
        // Someone else won; our customer is an orphan. Re-fetch and delete it.
        const reread = await admin
          .from('profiles')
          .select('stripe_customer_id')
          .eq('id', user.id)
          .maybeSingle();
        if (reread.error || !reread.data) {
          // Best-effort cleanup before surfacing.
          try {
            await stripe.customers.del(customer.id);
          } catch {
            /* swallow — primary error wins */
          }
          throw new Error(
            `profile re-read failed after concurrent customer creation: ${
              reread.error?.message ?? 'profile missing'
            }`,
          );
        }
        const winner = (reread.data as { stripe_customer_id: string | null })
          .stripe_customer_id;
        if (!winner) {
          // The losing-side reread saw null too — extremely unlikely, but the
          // safest action is to abort this request without leaking a customer.
          try {
            await stripe.customers.del(customer.id);
          } catch {
            /* swallow */
          }
          throw new Error(
            'concurrent customer creation: profile still has no stripe_customer_id',
          );
        }
        // Delete our orphan; log if it fails so we can reconcile out-of-band.
        try {
          await stripe.customers.del(customer.id);
        } catch (delErr) {
          // M-S2: scrub the message before Sentry serialization (the
          // exception text can echo customer email/address).
          Sentry.captureException(
            new Error(scrubString(String(delErr))),
            {
              tags: { area: 'stripe.checkout.orphan_cleanup' },
              extra: { orphanCustomerId: customer.id, winningCustomerId: winner, userId: user.id },
            },
          );
        }
        stripeCustomerId = winner;
      }
    }

    const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');

    const sharedParams = {
      customer: stripeCustomerId,
      client_reference_id: user.id,
      success_url: `${appUrl}/dashboard?checkout=success`,
      cancel_url: `${appUrl}/pricing`,
      metadata: { userId: user.id, mode },
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto' },
    } as const;

    const session =
      mode === 'one_time'
        ? await stripe.checkout.sessions.create({
            ...sharedParams,
            mode: 'payment',
            line_items: [
              { price: env.STRIPE_PRICE_ID_ONE_TIME, quantity: 1 },
            ],
          })
        : await stripe.checkout.sessions.create({
            ...sharedParams,
            mode: 'subscription',
            line_items: [
              { price: env.STRIPE_PRICE_ID_SUBSCRIPTION, quantity: 1 },
            ],
          });

    if (!session.url) {
      throw new Error('Stripe session has no url');
    }

    return Response.json({ url: session.url });
  } catch (err) {
    console.error('[stripe.checkout] unexpected error', err instanceof Error ? err.message : 'unknown');
    Sentry.captureException(err, { tags: { area: 'stripe.checkout' } });
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
