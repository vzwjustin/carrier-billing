import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import { trackServer } from '@/lib/analytics/events';

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
 * Throwing from here means the parent webhook will capture to Sentry and still
 * return 200 — the event has been persisted, so we can replay later.
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  supabase: SupabaseClient,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await onCheckoutSessionCompleted(
        event.data.object as Stripe.Checkout.Session,
        supabase,
      );
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await onSubscriptionUpserted(
        event.data.object as Stripe.Subscription,
        supabase,
      );
      return;
    case 'customer.subscription.deleted':
      await onSubscriptionDeleted(
        event.data.object as Stripe.Subscription,
        supabase,
      );
      return;
    case 'invoice.payment_failed':
      await onInvoicePaymentFailed(
        event.data.object as Stripe.Invoice,
        supabase,
      );
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
    Sentry.captureMessage(
      'checkout.session.completed without resolvable userId',
      { level: 'warning', extra: { session_id: session.id } },
    );
    return;
  }

  const customerId = readCustomerId(session.customer);

  if (session.mode === 'payment') {
    // One-time audit purchase: bump credit counter via RPC for atomicity.
    const { error: rpcError } = await supabase.rpc(
      'increment_audit_credits',
      { profile_id: userId, delta: 1 },
    );
    if (rpcError) {
      throw new Error(
        `increment_audit_credits failed: ${rpcError.message}`,
      );
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
): Promise<void> {
  const customerId = readCustomerId(subscription.customer);
  if (!customerId) {
    Sentry.captureMessage(
      'subscription event without customer id',
      { level: 'warning', extra: { subscription_id: subscription.id } },
    );
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .update({
      subscription_id: subscription.id,
      subscription_status: subscription.status,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', customerId);

  if (error) {
    throw new Error(`profile subscription update failed: ${error.message}`);
  }
}

async function onSubscriptionDeleted(
  subscription: Stripe.Subscription,
  supabase: SupabaseClient,
): Promise<void> {
  const customerId = readCustomerId(subscription.customer);
  if (!customerId) {
    Sentry.captureMessage(
      'subscription.deleted without customer id',
      { level: 'warning', extra: { subscription_id: subscription.id } },
    );
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .update({
      subscription_status: 'canceled',
      subscription_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', customerId);

  if (error) {
    throw new Error(`profile subscription cancel failed: ${error.message}`);
  }
}

async function onInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  supabase: SupabaseClient,
): Promise<void> {
  const customerId = readCustomerId(invoice.customer);
  if (!customerId) {
    Sentry.captureMessage(
      'invoice.payment_failed without customer id',
      { level: 'warning', extra: { invoice_id: invoice.id } },
    );
    return;
  }

  Sentry.addBreadcrumb({
    category: 'stripe',
    message: 'invoice.payment_failed',
    level: 'warning',
    data: { invoice_id: invoice.id, customer: customerId },
  });

  const { error } = await supabase
    .from('profiles')
    .update({
      subscription_status: 'past_due',
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', customerId);

  if (error) {
    throw new Error(`profile past_due update failed: ${error.message}`);
  }
}

async function trackCheckoutCompleted(
  mode: 'one_time' | 'subscription',
  userId: string,
): Promise<void> {
  try {
    await trackServer(
      { name: 'checkout_completed', properties: { mode, userId } },
      userId,
    );
  } catch {
    // Analytics must never break a webhook handler.
  }
}

// --- Helpers ---------------------------------------------------------------

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

function readUserIdFromSession(
  session: Stripe.Checkout.Session,
): string | null {
  if (
    typeof session.client_reference_id === 'string' &&
    session.client_reference_id.length > 0
  ) {
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

function readSubscriptionId(
  sub: string | Stripe.Subscription | null | undefined,
): string | null {
  if (typeof sub === 'string' && sub.length > 0) return sub;
  if (sub && typeof sub === 'object' && 'id' in sub) {
    const id = (sub as { id: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}
