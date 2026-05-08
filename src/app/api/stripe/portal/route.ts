export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import * as Sentry from '@sentry/nextjs';

import { env } from '@/env';
import { getStripe } from '@/lib/stripe/client';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

/**
 * Create a Stripe billing portal session for the authenticated user.
 *
 * The portal is where users update payment methods, view invoices, and cancel
 * subscriptions. We require a pre-existing Stripe customer id — users without
 * one (i.e. no purchase history) get a 400 and should go to /pricing instead.
 */
export async function POST(): Promise<Response> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    const admin = getAdminClient();
    const profileResult = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle();

    if (profileResult.error) {
      throw new Error(
        `profile lookup failed: ${profileResult.error.message}`,
      );
    }

    const profile = profileResult.data as {
      stripe_customer_id: string | null;
    } | null;

    const stripeCustomerId = profile?.stripe_customer_id;
    if (!stripeCustomerId) {
      return Response.json({ error: 'no_customer' }, { status: 400 });
    }

    const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');

    const session = await getStripe().billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${appUrl}/settings/billing`,
    });

    return Response.json({ url: session.url });
  } catch (err) {
    console.error('[stripe.portal] unexpected error', err);
    Sentry.captureException(err, { tags: { area: 'stripe.portal' } });
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
