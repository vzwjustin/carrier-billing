export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stripe Checkout session creation.
 *
 * TODO(phase-4): create Stripe Checkout session. Should accept a `mode` flag
 * (one_time | subscription), look up the relevant `STRIPE_PRICE_ID_*`, set
 * `client_reference_id` to the authenticated user's id, success URL to
 * `${NEXT_PUBLIC_APP_URL}/dashboard?checkout=success`, cancel URL to
 * `${NEXT_PUBLIC_APP_URL}/pricing`.
 */
export async function POST(): Promise<Response> {
  return Response.json({ error: 'not_implemented' }, { status: 501 });
}
