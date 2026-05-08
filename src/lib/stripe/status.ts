/**
 * Normalized subscription status matching the documented schema for
 * `profiles.subscription_status` (CLAUDE.md §4) plus `'trialing'`, which the
 * access gate treats as access-granting.
 *
 * Why an allowlist: Stripe's full status set includes additional values
 * (`incomplete`, `incomplete_expired`, `unpaid`, `paused`, plus future
 * additions) that the rest of the system has no semantics for. Writing them
 * raw to the DB leaks Stripe internals through the schema and into the UI
 * (`settings/billing` renders the status string directly).
 */
export type NormalizedSubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled';

/**
 * Coerce any Stripe subscription status string into our small normalized set.
 *
 * Fail-closed: unknown statuses (including future Stripe additions) map to
 * `past_due` so the access gate denies new audits until we explicitly handle
 * the new state. Better to inconvenience a paying user than to grant access
 * on an unrecognized state.
 */
export function normalizeSubscriptionStatus(
  status: string,
): NormalizedSubscriptionStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'canceled':
      return 'canceled';
    case 'past_due':
    case 'incomplete':
    case 'incomplete_expired':
    case 'unpaid':
    case 'paused':
      return 'past_due';
    default:
      return 'past_due';
  }
}
