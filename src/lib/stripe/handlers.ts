import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import { inngest } from '@/inngest/client';
import { trackServer } from '@/lib/analytics/events';
import { normalizeSubscriptionStatus } from '@/lib/stripe/status';

/**
 * Stripe event handler. Branches on `event.type` and applies the corresponding
 * mutation to `public.profiles`.
 *
 * Idempotency contract: callers (the webhook route) MUST gate this function on
 * the `billing_events.stripe_event_id` unique constraint so that the same
 * Stripe event id is never handled twice. Each branch is also written to be
 * naturally idempotent (subscription updates are upserts of the canonical
 * status; the only non-idempotent mutation is the credit increment, which is
 * exactly why the dedupe is required).
 *
 * Throwing from here means the parent webhook will record the handler error and
 * return 500 so Stripe retries. The receipt row is only deduped after the route
 * marks it handled.
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  supabase: SupabaseClient,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await onCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session, supabase);
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      // C4 — pass event type so the handler can attribute the upsert.
      await onSubscriptionUpserted(event.data.object as Stripe.Subscription, supabase, event.type);
      return;
    case 'customer.subscription.deleted':
      await onSubscriptionDeleted(event.data.object as Stripe.Subscription, supabase);
      return;
    case 'invoice.payment_failed':
      await onInvoicePaymentFailed(event.data.object as Stripe.Invoice, supabase);
      return;
    default:
      // Not a handled event type — no-op. The webhook still persisted the
      // event to billing_events for audit/observability.
      return;
  }
}

// --- Branch handlers --------------------------------------------------------

async function onCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  supabase: SupabaseClient,
): Promise<void> {
  const userId = readUserIdFromSession(session);
  if (!userId) {
    Sentry.captureMessage('checkout.session.completed without resolvable userId', {
      level: 'warning',
      extra: { session_id: session.id },
    });
    return;
  }

  const customerId = readCustomerId(session.customer);

  if (session.mode === 'payment') {
    // One-time audit purchase: bump credit counter via RPC for atomicity.
    const { error: rpcError } = await supabase.rpc('increment_audit_credits', {
      profile_id: userId,
      delta: 1,
    });
    if (rpcError) {
      throw new Error(`increment_audit_credits failed: ${rpcError.message}`);
    }

    if (customerId) {
      await updateProfile(supabase, userId, {
        stripe_customer_id: customerId,
      });
    }
    await trackCheckoutCompleted('one_time', userId);
    return;
  }

  if (session.mode === 'subscription') {
    const subscriptionId = readSubscriptionId(session.subscription);
    const patch: ProfilePatch = {
      subscription_status: 'active',
      subscription_id: subscriptionId,
    };
    if (customerId) patch.stripe_customer_id = customerId;
    await updateProfile(supabase, userId, patch);
    await trackCheckoutCompleted('subscription', userId);
    return;
  }

  // session.mode === 'setup' or other — not used by our checkout, ignore.
}

async function onSubscriptionUpserted(
  subscription: Stripe.Subscription,
  supabase: SupabaseClient,
  eventType: 'customer.subscription.created' | 'customer.subscription.updated',
): Promise<void> {
  // C4 — observability breadcrumb so Sentry traces show which Stripe event
  // type triggered this upsert (created vs updated). No behavior change.
  Sentry.addBreadcrumb({
    category: 'stripe',
    message: 'subscription upserted',
    level: 'info',
    data: {
      event_type: eventType,
      subscription_id: subscription.id,
      status: subscription.status,
    },
  });

  const customerId = readCustomerId(subscription.customer);
  if (!customerId) {
    Sentry.captureMessage('subscription event without customer id', {
      level: 'warning',
      extra: { subscription_id: subscription.id, event_type: eventType },
    });
    return;
  }

  // B7 — verify the update actually matched a profile. A 0-row result means
  // the customer id is unknown to us (orphaned customer, race with a profile
  // delete, or Stripe sending an event for a customer we never persisted).
  // In that case throw so the webhook surfaces 5xx and Stripe retries; >1 row
  // means data corruption (duplicate stripe_customer_id) and must throw too.
  const { data, error } = await supabase
    .from('profiles')
    .update({
      subscription_id: subscription.id,
      subscription_status: normalizeSubscriptionStatus(subscription.status),
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', customerId)
    .select('id');

  if (error) {
    throw new Error(`profile subscription update failed: ${error.message}`);
  }

  assertExactlyOneProfileMatched(data, customerId, eventType);
}

async function onSubscriptionDeleted(
  subscription: Stripe.Subscription,
  supabase: SupabaseClient,
): Promise<void> {
  const customerId = readCustomerId(subscription.customer);
  if (!customerId) {
    Sentry.captureMessage('subscription.deleted without customer id', {
      level: 'warning',
      extra: { subscription_id: subscription.id },
    });
    return;
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({
      subscription_status: 'canceled',
      subscription_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', customerId)
    .select('id');

  if (error) {
    throw new Error(`profile subscription cancel failed: ${error.message}`);
  }

  assertExactlyOneProfileMatched(data, customerId, 'customer.subscription.deleted');
}

async function onInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  supabase: SupabaseClient,
): Promise<void> {
  const customerId = readCustomerId(invoice.customer);
  if (!customerId) {
    Sentry.captureMessage('invoice.payment_failed without customer id', {
      level: 'warning',
      extra: { invoice_id: invoice.id },
    });
    return;
  }

  Sentry.addBreadcrumb({
    category: 'stripe',
    message: 'invoice.payment_failed',
    level: 'warning',
    data: { invoice_id: invoice.id, customer: customerId },
  });

  // We need the userId + customer email to emit the notification marker, so
  // resolve the profile via the same UPDATE that flips status to past_due.
  const { data, error } = await supabase
    .from('profiles')
    .update({
      subscription_status: 'past_due',
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', customerId)
    .select('id, email');

  if (error) {
    throw new Error(`profile past_due update failed: ${error.message}`);
  }

  const matched = assertExactlyOneProfileMatched(data, customerId, 'invoice.payment_failed');

  const profile = matched as { id: string; email?: string | null };
  const customerEmail = profile.email ?? null;

  if (!customerEmail) {
    Sentry.captureMessage('payment_failed: profile has no email', {
      level: 'warning',
      extra: { userId: profile.id },
    });
    return;
  }

  // Dispatch the notification email via Inngest. Wrapped in try/catch because
  // a dispatch failure must NOT roll back the past_due profile update — the
  // user's billing state is more important than the email. Inngest will
  // retry the email function on its own once delivered.
  try {
    await inngest.send({
      name: 'billing.payment_failed',
      data: {
        userId: profile.id,
        customerEmail,
        stripeCustomerId: customerId,
        invoiceId: invoice.id ?? null,
        amountDueCents: typeof invoice.amount_due === 'number' ? invoice.amount_due : null,
      },
    });
  } catch (sendErr) {
    Sentry.captureException(sendErr, {
      tags: { surface: 'stripe.payment_failed.dispatch' },
      extra: { userId: profile.id, invoiceId: invoice.id ?? null },
    });
  }
}

async function trackCheckoutCompleted(
  mode: 'one_time' | 'subscription',
  userId: string,
): Promise<void> {
  try {
    await trackServer({ name: 'checkout_completed', properties: { mode, userId } }, userId);
  } catch {
    // Analytics must never break a webhook handler.
  }
}

// --- Helpers ---------------------------------------------------------------

/**
 * Verify that a profile-update affected exactly one row when matching by
 * `stripe_customer_id`.
 *
 * - 0 rows: customer id is unknown to us. Log to Sentry and throw — the
 *   webhook will surface 5xx and Stripe will retry, giving any racing
 *   profile-write a chance to land first.
 * - 1 row: happy path; returns the matched row for downstream use.
 * - >1 rows: data corruption (duplicate stripe_customer_id across profiles).
 *   Throw immediately so we surface and repair manually.
 */
function assertExactlyOneProfileMatched<T extends { id: string }>(
  rows: T[] | null,
  customerId: string,
  eventType: string,
): T {
  const matched = rows ?? [];
  if (matched.length === 0) {
    Sentry.captureMessage('stripe webhook matched 0 profiles by customer id', {
      level: 'warning',
      extra: { customerId, eventType },
    });
    throw new Error(`profile lookup by stripe_customer_id matched 0 rows (${eventType})`);
  }
  if (matched.length > 1) {
    Sentry.captureMessage('stripe webhook matched multiple profiles by customer id', {
      level: 'error',
      extra: { customerId, eventType, matchCount: matched.length },
    });
    throw new Error(
      `profile lookup by stripe_customer_id matched ${matched.length} rows (${eventType}) — data corruption`,
    );
  }
  return matched[0] as T;
}

type ProfilePatch = {
  stripe_customer_id?: string;
  subscription_id?: string | null;
  subscription_status?: string | null;
};

async function updateProfile(
  supabase: SupabaseClient,
  userId: string,
  patch: ProfilePatch,
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) {
    throw new Error(`profile update failed: ${error.message}`);
  }
}

function readUserIdFromSession(session: Stripe.Checkout.Session): string | null {
  if (typeof session.client_reference_id === 'string' && session.client_reference_id.length > 0) {
    return session.client_reference_id;
  }
  const md = session.metadata;
  if (md && typeof md === 'object') {
    const candidate = (md as Record<string, unknown>)['userId'];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function readCustomerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string | null {
  if (typeof customer === 'string' && customer.length > 0) return customer;
  if (customer && typeof customer === 'object' && 'id' in customer) {
    const id = (customer as { id: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

function readSubscriptionId(sub: string | Stripe.Subscription | null | undefined): string | null {
  if (typeof sub === 'string' && sub.length > 0) return sub;
  if (sub && typeof sub === 'object' && 'id' in sub) {
    const id = (sub as { id: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}
