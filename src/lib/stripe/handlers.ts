import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import { inngest } from '@/inngest/client';
import { trackServer } from '@/lib/analytics/events';
import { scrubString } from '@/lib/observability/redact';
import { normalizeSubscriptionStatus } from '@/lib/stripe/status';

/**
 * Stripe event handler. Branches on `event.type` and applies the corresponding
 * mutation to `public.profiles`.
 *
 * Idempotency contract: callers (the webhook route + the replay cron) gate
 * this function on the `billing_events.stripe_event_id` unique constraint so
 * that the same Stripe event id is never persisted twice. On retry, callers
 * pass `previousStatus` in the context so non-idempotent mutations (the
 * credit grant in checkout.session.completed) can short-circuit and avoid
 * double-effects.
 *
 * Throwing from here surfaces a 5xx out of the webhook route so Stripe
 * automatically retries (H8). Each branch is written to be safe under retry:
 * subscription updates are timestamp-guarded upserts, the past_due update is
 * idempotent, and the credit grant is gated on `previousStatus === null`.
 */
export type HandlerContext = {
  /** processed_status of the billing_events row at the start of this attempt. */
  previousStatus: 'success' | 'failed' | 'in_flight' | null;
  /** UUID of the billing_events row backing this attempt. Required for the
   *  atomic `grant_credit_once` RPC so retries idempotently target the same
   *  per-event flag rather than gating on `previousStatus` (C1). */
  billingEventId: string;
};

const DEFAULT_CONTEXT: HandlerContext = {
  previousStatus: null,
  billingEventId: '',
};

export async function handleStripeEvent(
  event: Stripe.Event,
  supabase: SupabaseClient,
  context: HandlerContext = DEFAULT_CONTEXT,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await onCheckoutSessionCompleted(
        event.data.object as Stripe.Checkout.Session,
        supabase,
        context,
      );
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      // C4 — pass event type so the handler can attribute the upsert.
      // H9 — pass event.created so the handler can refuse out-of-order updates.
      await onSubscriptionUpserted(
        event.data.object as Stripe.Subscription,
        supabase,
        event.type,
        event.created,
      );
      return;
    case 'customer.subscription.deleted':
      await onSubscriptionDeleted(
        event.data.object as Stripe.Subscription,
        supabase,
        event.created,
      );
      return;
    case 'invoice.payment_failed':
      // H2: pass event.created so the past_due flip honors the same
      // ordering guard subscription events use (a delayed payment_failed
      // arriving after a recovery must NOT resurrect past_due).
      await onInvoicePaymentFailed(
        event.data.object as Stripe.Invoice,
        supabase,
        event.created,
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
  context: HandlerContext,
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
    // C1: atomic grant-once via `grant_credit_once(event_id, profile_id, delta)`.
    // The RPC flips `billing_events.credit_granted` from false→true and
    // increments `profiles.audit_credits` in a single transaction. Returns
    // true if this call performed the grant, false if a prior call already
    // did. Both branches mean "credit is now applied" — only the boolean
    // tells us whether this attempt mutated state.
    //
    // This replaces the old previousStatus-gated approach which lost the
    // credit permanently if the very first RPC call failed before bookkeeping
    // could land. Retries (Stripe delivery + replay cron) now safely re-attempt
    // until credit_granted=true.
    if (!context.billingEventId) {
      throw new Error(
        'onCheckoutSessionCompleted: missing billingEventId in context (caller must pass it)',
      );
    }
    const { data: granted, error: rpcError } = await supabase.rpc(
      'grant_credit_once',
      {
        p_event_id: context.billingEventId,
        p_profile_id: userId,
        p_delta: 1,
      },
    );
    if (rpcError) {
      throw new Error(`grant_credit_once failed: ${rpcError.message}`);
    }
    if (granted === false) {
      Sentry.addBreadcrumb({
        category: 'stripe',
        message: 'checkout.session.completed: credit already granted (idempotent retry)',
        level: 'info',
        data: { userId, billingEventId: context.billingEventId },
      });
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
    // H11: do NOT write `subscription_status='active'` here. Stripe sends
    // checkout.session.completed *after* the subscription is created, so the
    // subscription.created event (handled by onSubscriptionUpserted with the
    // H9 ordering guard) is the authoritative source of subscription_status.
    // Writing 'active' unconditionally here grants premature paid access for
    // subscriptions in `incomplete` state (3DS pending, payment-method-required).
    // We still record the subscription_id and link the customer id so the
    // profile is wired up before the subscription event lands.
    const subscriptionId = readSubscriptionId(session.subscription);
    const patch: ProfilePatch = { subscription_id: subscriptionId };
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
  eventType:
    | 'customer.subscription.created'
    | 'customer.subscription.updated',
  eventCreated: number,
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
    Sentry.captureMessage(
      'subscription event without customer id',
      {
        level: 'warning',
        extra: { subscription_id: subscription.id, event_type: eventType },
      },
    );
    return;
  }

  // H6: surface cancel_at_period_end + current_period_end so /settings/billing
  // can render "your access ends on <date>" instead of leaving the user
  // guessing whether their cancellation went through.
  const cancelAtPeriodEnd =
    typeof (subscription as { cancel_at_period_end?: unknown })
      .cancel_at_period_end === 'boolean'
      ? Boolean((subscription as { cancel_at_period_end: boolean }).cancel_at_period_end)
      : false;
  const periodEndUnix = (subscription as { current_period_end?: unknown })
    .current_period_end;
  const currentPeriodEnd =
    typeof periodEndUnix === 'number' && periodEndUnix > 0
      ? new Date(periodEndUnix * 1000).toISOString()
      : null;

  const patch: ProfilePatch = {
    subscription_id: subscription.id,
    subscription_status: normalizeSubscriptionStatus(subscription.status),
    cancel_at_period_end: cancelAtPeriodEnd,
    current_period_end: currentPeriodEnd,
  };

  const applied = await applySubscriptionPatchWithOrderGuard(
    supabase,
    customerId,
    eventType,
    eventCreated,
    patch,
  );

  // H-1: subscription.created can arrive before checkout.session.completed.
  // When that happens, the profile hasn't yet been linked to the Stripe
  // customer and the customer-id lookup matches 0 rows. Previously this
  // threw and Stripe retried until checkout landed, burning warnings.
  // For subscription.created only, fall back to userId resolved from the
  // subscription's metadata (Stripe Checkout copies session.metadata onto
  // the subscription), link the profile, and retry the patch by userId.
  if (
    applied === NO_MATCH_NON_TERMINAL &&
    eventType === 'customer.subscription.created'
  ) {
    const userId = deriveUserIdFromSubscription(subscription);
    if (!userId) {
      Sentry.captureMessage(
        'subscription.created arrived before profile link; no fallback userId',
        {
          level: 'warning',
          extra: {
            subscription_id: subscription.id,
            customer_id: customerId,
          },
        },
      );
      return;
    }
    // Link the profile and apply the patch by id. Patch is keyed by id and
    // the order guard column is updated transactionally below.
    await applySubscriptionPatchByUserId(supabase, userId, customerId, eventCreated, patch);
  }
}

/**
 * Resolve a userId from a Stripe.Subscription's metadata. Stripe Checkout
 * copies the session's metadata onto the subscription it creates, so the
 * `userId` we stamp on the Checkout session is reachable here.
 */
function deriveUserIdFromSubscription(
  subscription: Stripe.Subscription,
): string | null {
  const md = subscription.metadata;
  if (md && typeof md === 'object') {
    const candidate = (md as Record<string, unknown>)['userId'];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * H-1 fallback: when the customer-id lookup misses (profile not yet linked)
 * apply the subscription patch keyed by the userId resolved from event
 * metadata. Links `stripe_customer_id` in the same update and writes the
 * order-guard timestamp so a later customer-id-keyed event correctly sees
 * us as the freshest writer.
 */
async function applySubscriptionPatchByUserId(
  supabase: SupabaseClient,
  userId: string,
  customerId: string,
  eventCreated: number,
  patch: ProfilePatch,
): Promise<void> {
  const eventCreatedAt = new Date(eventCreated * 1000).toISOString();
  const { data: updatedRows, error: updateErr } = await supabase
    .from('profiles')
    .update({
      ...patch,
      stripe_customer_id: customerId,
      subscription_event_at: eventCreatedAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .or(
      `subscription_event_at.is.null,subscription_event_at.lt.${eventCreatedAt}`,
    )
    .select('id');

  if (updateErr) {
    throw new Error(
      `subscription patch (fallback by userId) failed: ${updateErr.message}`,
    );
  }
  const rows = (updatedRows ?? []) as Array<{ id: string }>;
  if (rows.length === 0) {
    Sentry.captureMessage(
      'subscription.created fallback: no profile matched by userId',
      {
        level: 'warning',
        extra: { userId, customerId },
      },
    );
    return;
  }
  Sentry.addBreadcrumb({
    category: 'stripe',
    message: 'subscription.created applied via userId fallback (linked profile)',
    level: 'info',
    data: { userId, customerId },
  });
}

async function onSubscriptionDeleted(
  subscription: Stripe.Subscription,
  supabase: SupabaseClient,
  eventCreated: number,
): Promise<void> {
  const customerId = readCustomerId(subscription.customer);
  if (!customerId) {
    Sentry.captureMessage(
      'subscription.deleted without customer id',
      { level: 'warning', extra: { subscription_id: subscription.id } },
    );
    return;
  }

  await applySubscriptionPatchWithOrderGuard(
    supabase,
    customerId,
    'customer.subscription.deleted',
    eventCreated,
    {
      subscription_status: 'canceled',
      subscription_id: null,
      cancel_at_period_end: false,
      current_period_end: null,
    },
  );
}

/**
 * H9 + H4: SELECT for row-id lookup, then CAS UPDATE that re-checks the
 * ordering guard inside the WHERE clause so the database arbitrates.
 *
 * Why the WHERE-side guard matters (H4): the previous implementation read
 * `subscription_event_at` in a SELECT and then issued an unconditional UPDATE
 * keyed by id. That was OK as long as Stripe's own per-subscription delivery
 * was the only source of events — Stripe serializes deliveries per object so
 * a SELECT-then-UPDATE in a single handler run could not race a sibling
 * webhook hitting the same row. The H8 replay cron broke that invariant: a
 * cron tick replaying a stale event can run concurrently with a fresh
 * subscription.updated, and the SELECT/UPDATE window is wide enough for the
 * stale patch to clobber the fresh one.
 *
 * Fix: the UPDATE is conditional on `subscription_event_at IS NULL OR
 * subscription_event_at < eventCreatedAt`, so the older event's UPDATE
 * affects 0 rows when a fresher one has already landed. We `.select('id')`
 * to learn the row count and log a Sentry breadcrumb on the rejected case.
 */
async function applySubscriptionPatchWithOrderGuard(
  supabase: SupabaseClient,
  customerId: string,
  eventType: string,
  eventCreated: number,
  patch: ProfilePatch,
): Promise<typeof NO_MATCH_NON_TERMINAL | void> {
  const eventCreatedAt = new Date(eventCreated * 1000).toISOString();

  const { data: profiles, error: selectErr } = await supabase
    .from('profiles')
    .select('id, subscription_event_at')
    .eq('stripe_customer_id', customerId);

  if (selectErr) {
    throw new Error(`profile lookup failed: ${selectErr.message}`);
  }

  // H-1: subscription.created can land before checkout.session.completed
  // has linked the profile. Return a tolerant sentinel so the caller can
  // attempt a userId-based fallback instead of throwing.
  const rows = (profiles ?? []) as Array<{ id: string; subscription_event_at?: string | null }>;
  if (rows.length === 0 && eventType === 'customer.subscription.created') {
    Sentry.addBreadcrumb({
      category: 'stripe',
      level: 'info',
      message: 'subscription.created 0-row match by customer id — will attempt userId fallback',
      data: { customerId, eventType },
    });
    return NO_MATCH_NON_TERMINAL;
  }

  const matched = assertExactlyOneProfileMatched(
    rows,
    customerId,
    eventType,
  );
  // H11: terminal-event no-op signal. Profile was already deleted locally.
  if (matched === NO_MATCH) return;

  // Pre-check the in-memory snapshot so we still emit the breadcrumb in the
  // common single-writer case without relying on the database to tell us.
  const currentEventAt = matched.subscription_event_at ?? null;
  if (currentEventAt !== null && currentEventAt >= eventCreatedAt) {
    Sentry.addBreadcrumb({
      category: 'stripe',
      message: 'ignoring out-of-order subscription event',
      level: 'info',
      data: {
        eventType,
        eventCreatedAt,
        currentEventAt,
        customerId,
      },
    });
    return;
  }

  // CAS: the UPDATE only fires if subscription_event_at is still null or
  // strictly older than this event. If a concurrent (fresher) writer already
  // landed between our SELECT above and this UPDATE, the WHERE clause will
  // match 0 rows and we bail out without overwriting.
  const { data: updatedRows, error: updateErr } = await supabase
    .from('profiles')
    .update({
      ...patch,
      subscription_event_at: eventCreatedAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', matched.id)
    .or(
      `subscription_event_at.is.null,subscription_event_at.lt.${eventCreatedAt}`,
    )
    .select('id');

  if (updateErr) {
    throw new Error(`profile subscription update failed: ${updateErr.message}`);
  }

  const rows2 = (updatedRows ?? []) as Array<{ id: string }>;
  if (rows2.length === 0) {
    Sentry.addBreadcrumb({
      category: 'stripe',
      message: 'subscription patch rejected by CAS guard (fresher event won)',
      level: 'info',
      data: {
        eventType,
        eventCreatedAt,
        customerId,
      },
    });
    return;
  }
}

async function onInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  supabase: SupabaseClient,
  eventCreated: number,
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

  // H2: route the past_due flip through the same ordering guard subscription
  // events use. Stripe does NOT serialize between subscription.* and invoice.*
  // deliveries, so a delayed `invoice.payment_failed` can arrive AFTER a
  // subscription.updated→active recovery and would otherwise resurrect the
  // stale past_due. The CAS guard inside the helper drops the patch when a
  // fresher subscription_event_at has already landed.
  const eventCreatedAt = new Date(eventCreated * 1000).toISOString();

  const { data: profiles, error: selectErr } = await supabase
    .from('profiles')
    .select('id, subscription_event_at')
    .eq('stripe_customer_id', customerId);

  if (selectErr) {
    throw new Error(`profile lookup failed: ${selectErr.message}`);
  }

  const matchedForGuard = assertExactlyOneProfileMatched(
    profiles as Array<{ id: string; subscription_event_at?: string | null }> | null,
    customerId,
    'invoice.payment_failed',
  );
  // H11: account was already deleted locally; no past_due flip, no email.
  if (matchedForGuard === NO_MATCH) return;

  const currentEventAt = matchedForGuard.subscription_event_at ?? null;
  if (currentEventAt !== null && currentEventAt >= eventCreatedAt) {
    Sentry.addBreadcrumb({
      category: 'stripe',
      message: 'ignoring out-of-order invoice.payment_failed',
      level: 'info',
      data: {
        eventCreatedAt,
        currentEventAt,
        customerId,
      },
    });
    return;
  }

  const { data: updatedRows, error: updateErr } = await supabase
    .from('profiles')
    .update({
      subscription_status: 'past_due',
      subscription_event_at: eventCreatedAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', matchedForGuard.id)
    .or(
      `subscription_event_at.is.null,subscription_event_at.lt.${eventCreatedAt}`,
    )
    .select('id, email');

  if (updateErr) {
    throw new Error(`profile past_due update failed: ${updateErr.message}`);
  }

  const rows = (updatedRows ?? []) as Array<{ id: string; email?: string | null }>;
  if (rows.length === 0) {
    // Fresher event won between SELECT and UPDATE — skip the email too.
    Sentry.addBreadcrumb({
      category: 'stripe',
      message: 'invoice.payment_failed CAS rejected (fresher event won)',
      level: 'info',
      data: { eventCreatedAt, customerId },
    });
    return;
  }

  const profile = rows[0]!;
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
  // user's billing state is more important than the email. The consumer
  // re-fetches the profile by userId so we deliberately do NOT include the
  // email in the event payload (C2 — PII discipline).
  try {
    await inngest.send({
      name: 'billing.payment_failed',
      data: {
        userId: profile.id,
        stripeCustomerId: customerId,
        invoiceId: invoice.id ?? null,
        amountDueCents:
          typeof invoice.amount_due === 'number' ? invoice.amount_due : null,
      },
    });
  } catch (sendErr) {
    // M-S2: the underlying Stripe/Inngest error message can echo customer
    // email/address. scrubString strips emails, phones, and long digit runs
    // before the message is forwarded to Sentry's serializer.
    //
    // M16: level 'error' (not the default 'error' of captureException which
    // is actually appropriate, but explicit so dashboard filters/alerts
    // include it). If Inngest is down and we silently drop payment-failed
    // emails, paying customers don't learn their card was declined until
    // their access cuts off — a serious DX/revenue issue we must alert on.
    Sentry.captureException(
      new Error(scrubString(sendErr instanceof Error ? sendErr.message : String(sendErr))),
      {
        level: 'error',
        tags: { surface: 'stripe.payment_failed.dispatch' },
        extra: { userId: profile.id, invoiceId: invoice.id ?? null },
      },
    );
  }
}

async function trackCheckoutCompleted(
  mode: 'one_time' | 'subscription',
  userId: string,
): Promise<void> {
  try {
    await trackServer(
      { name: 'checkout_completed', properties: { mode } },
      userId,
    );
  } catch {
    // Analytics must never break a webhook handler.
  }
}

// --- Helpers ---------------------------------------------------------------

/**
 * Sentinel type for the case where 0 rows match. Some terminal event types
 * (subscription/account deletion) are expected to land after local cleanup
 * and must not throw; the caller can branch on this sentinel and return.
 */
const NO_MATCH = Symbol('no-match');
type NoMatch = typeof NO_MATCH;

/** H-1: non-terminal 0-row sentinel for `customer.subscription.created`. */
const NO_MATCH_NON_TERMINAL = Symbol('no-match-non-terminal');

const TERMINAL_EVENT_TYPES = new Set([
  'customer.subscription.deleted',
  'invoice.payment_failed',
]);

/**
 * Verify that a profile-update affected exactly one row when matching by
 * `stripe_customer_id`.
 *
 * - 0 rows + TERMINAL event: customer was deleted locally before Stripe's
 *   delivery caught up (e.g. user closed their account; Stripe keeps
 *   retrying for ~3 days). Log info-level and return a sentinel so the
 *   caller no-ops without a Sentry alert per retry. (H11)
 * - 0 rows + non-terminal event: unknown customer mid-lifecycle. Throw
 *   so the webhook 5xx's and Stripe retries — gives any racing profile
 *   write a chance to land.
 * - 1 row: happy path; returns the matched row for downstream use.
 * - >1 rows: data corruption (duplicate stripe_customer_id across profiles).
 *   Throw immediately so we surface and repair manually.
 */
function assertExactlyOneProfileMatched<T extends { id: string }>(
  rows: T[] | null,
  customerId: string,
  eventType: string,
): T | NoMatch {
  const matched = rows ?? [];
  if (matched.length === 0) {
    if (TERMINAL_EVENT_TYPES.has(eventType)) {
      // H11: account was already deleted locally. Suppress the warning-level
      // capture (which generated 13 alerts per deleted user across Stripe's
      // retry window) and signal a benign no-op to the caller.
      Sentry.addBreadcrumb({
        category: 'stripe',
        level: 'info',
        message:
          'stripe webhook 0-row match on terminal event (profile likely deleted) — no-op',
        data: { customerId, eventType },
      });
      return NO_MATCH;
    }
    Sentry.captureMessage('stripe webhook matched 0 profiles by customer id', {
      level: 'warning',
      extra: { customerId, eventType },
    });
    throw new Error(
      `profile lookup by stripe_customer_id matched 0 rows (${eventType})`,
    );
  }
  if (matched.length > 1) {
    Sentry.captureMessage(
      'stripe webhook matched multiple profiles by customer id',
      {
        level: 'error',
        extra: { customerId, eventType, matchCount: matched.length },
      },
    );
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
  cancel_at_period_end?: boolean;
  current_period_end?: string | null;
};

async function updateProfile(
  supabase: SupabaseClient,
  userId: string,
  patch: ProfilePatch,
): Promise<void> {
  const { data, error } = await supabase
    .from('profiles')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select('id');
  if (error) {
    throw new Error(`profile update failed: ${error.message}`);
  }
  if ((data ?? []).length === 0) {
    throw new Error(`profile update matched 0 rows for userId=${userId}`);
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
