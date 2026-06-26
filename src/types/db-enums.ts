/**
 * M13 — narrow literal unions for columns with SQL CHECK domains.
 *
 * The DB declares CHECK constraints on `audits.status`, `audits.carrier`,
 * `findings.severity`, and `profiles.subscription_status`. The TypeScript
 * hand-rolled row types historically used `string`, which let typos like
 * `data.status === 'extracted'` (sic) compile without complaint while
 * always being false.
 *
 * These are the canonical TS-side mirrors of the DB CHECK domains. Use
 * them everywhere a Row interface or function signature describes one
 * of these columns. Drift between this file and the migrations becomes
 * a typecheck failure rather than a silent rows-don't-match bug.
 */

export type AuditStatus = 'pending' | 'extracting' | 'analyzing' | 'completed' | 'failed';

export const AUDIT_STATUSES: readonly AuditStatus[] = [
  'pending',
  'extracting',
  'analyzing',
  'completed',
  'failed',
] as const;

/** Mirrors `audits.carrier` CHECK domain (nullable). */
export type AuditCarrier =
  | 'verizon'
  | 'att'
  | 'tmobile'
  | 'uscellular'
  | 'spectrum'
  | 'xfinity'
  | 'cricket'
  | 'unknown';

/** Mirrors `findings.severity` CHECK domain. */
export type FindingSeverity = 'high' | 'medium' | 'low' | 'info';

/** Mirrors `profiles.subscription_status` CHECK domain (nullable). */
export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid'
  | 'paused';

export function isAuditStatus(value: unknown): value is AuditStatus {
  return typeof value === 'string' && (AUDIT_STATUSES as readonly string[]).includes(value);
}

export function isFindingSeverity(value: unknown): value is FindingSeverity {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'info';
}

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  if (typeof value !== 'string') return false;
  switch (value) {
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'canceled':
    case 'incomplete':
    case 'incomplete_expired':
    case 'unpaid':
    case 'paused':
      return true;
    default:
      return false;
  }
}
