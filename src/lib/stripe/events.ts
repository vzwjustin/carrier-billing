/**
 * The set of Stripe webhook event types CarrierAudit cares about.
 *
 * Phase 0: we persist all of these to `billing_events` for audit/observability,
 * but only log on receipt. Phase 4 will branch on these to mutate
 * `profiles.audit_credits` and `profiles.subscription_status`.
 */
export const HANDLED_STRIPE_EVENT_TYPES = {
  CheckoutSessionCompleted: 'checkout.session.completed',
  CheckoutSessionAsyncPaymentSucceeded:
    'checkout.session.async_payment_succeeded',
  CheckoutSessionAsyncPaymentFailed: 'checkout.session.async_payment_failed',
  CustomerSubscriptionCreated: 'customer.subscription.created',
  CustomerSubscriptionUpdated: 'customer.subscription.updated',
  CustomerSubscriptionDeleted: 'customer.subscription.deleted',
  InvoicePaymentFailed: 'invoice.payment_failed',
} as const;

export type HandledStripeEventType =
  (typeof HANDLED_STRIPE_EVENT_TYPES)[keyof typeof HANDLED_STRIPE_EVENT_TYPES];

const HANDLED_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  Object.values(HANDLED_STRIPE_EVENT_TYPES),
);

export function isHandledStripeEventType(
  type: string,
): type is HandledStripeEventType {
  return HANDLED_EVENT_TYPE_SET.has(type);
}

/**
 * Best-effort extraction of our internal `userId` from a Stripe event payload.
 *
 * Stripe events route a user back to us through one of three channels,
 * depending on the event type:
 *   - Checkout sessions carry `client_reference_id` (we set this to userId).
 *   - Subscription / invoice events carry `metadata.userId` if we attached it.
 *   - Otherwise the `customer` id is present and we can map it to a profile
 *     via `profiles.stripe_customer_id` (Phase 4 work — not done here).
 *
 * For Phase 0 we just return whatever we can read directly off the object.
 * The webhook's idempotency guarantee comes from the `stripe_event_id` unique
 * constraint, not from this function.
 */
export function deriveUserIdFromEventObject(
  obj: unknown,
): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;

  const clientRef = record['client_reference_id'];
  if (typeof clientRef === 'string' && clientRef.length > 0) {
    return clientRef;
  }

  const metadata = record['metadata'];
  if (metadata && typeof metadata === 'object') {
    const userId = (metadata as Record<string, unknown>)['userId'];
    if (typeof userId === 'string' && userId.length > 0) {
      return userId;
    }
  }

  return null;
}
