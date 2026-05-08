/**
 * scripts/lib/stripe-helpers.ts
 *
 * Idempotent Stripe product/price helpers for the bootstrap script.
 *
 * "Idempotent" here means: identification keys are written into product
 * metadata (`carrieraudit_kind`) so subsequent runs find the existing
 * product/price and avoid creating duplicates.
 */

import type Stripe from 'stripe';

export type StripeKind = 'one_time' | 'subscription';

/**
 * Find a CarrierAudit-owned product by its `carrieraudit_kind` metadata key,
 * or create it if missing. Marker metadata is the source of truth.
 */
export async function findOrCreateProduct(
  stripe: Stripe,
  name: string,
  kindMeta: StripeKind,
): Promise<{ product: Stripe.Product; created: boolean }> {
  // Stripe's search API supports metadata filters and is the cheapest lookup.
  const search = await stripe.products.search({
    query: `metadata['carrieraudit_kind']:'${kindMeta}' AND active:'true'`,
    limit: 1,
  });

  const existing = search.data[0];
  if (existing) {
    return { product: existing, created: false };
  }

  const product = await stripe.products.create({
    name,
    metadata: { carrieraudit_kind: kindMeta },
  });

  return { product, created: true };
}

/**
 * Find an active price on `productId` matching the given unit amount + recurring
 * shape, or create one. Recurring=null means a one-time price.
 */
export async function findOrCreatePrice(
  stripe: Stripe,
  productId: string,
  unitAmount: number,
  recurring: { interval: 'month' | 'year' } | null,
): Promise<{ price: Stripe.Price; created: boolean }> {
  // List active prices on the product (typically a small set).
  const prices = await stripe.prices.list({
    product: productId,
    active: true,
    limit: 100,
  });

  const match = prices.data.find((p) => {
    if (p.unit_amount !== unitAmount) return false;
    if (p.currency !== 'usd') return false;
    if (recurring === null) {
      return p.type === 'one_time';
    }
    return p.type === 'recurring' && p.recurring?.interval === recurring.interval;
  });

  if (match) {
    return { price: match, created: false };
  }

  const created = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: unitAmount,
    ...(recurring ? { recurring: { interval: recurring.interval } } : {}),
  });

  return { price: created, created: true };
}
