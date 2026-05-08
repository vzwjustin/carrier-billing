import { getAdminClient } from '@/lib/supabase/admin';

/**
 * Result of asking "is this user allowed to start a new audit right now?".
 *
 * - `subscription`: user has an active or trialing subscription; unlimited audits.
 * - `credit`: user has at least one one-time audit credit; will be decremented.
 * - `no_plan`: user has neither a subscription nor credits; send to /pricing.
 * - `past_due`: subscription is past_due. Per CLAUDE.md §11#9 we let in-flight
 *   audits finish but block any new ones.
 */
export type AccessGateResult =
  | { ok: true; reason: 'subscription' }
  | { ok: true; reason: 'credit'; remaining: number }
  | { ok: false; reason: 'no_plan' | 'past_due' };

interface ProfileRow {
  subscription_status: string | null;
  audit_credits: number | null;
}

function isProfileRow(value: unknown): value is ProfileRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const status = v['subscription_status'];
  const credits = v['audit_credits'];
  return (
    (status === null || typeof status === 'string') &&
    (credits === null || typeof credits === 'number')
  );
}

export async function assertCanRunAudit(
  userId: string,
): Promise<AccessGateResult> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('subscription_status,audit_credits')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data || !isProfileRow(data)) {
    return { ok: false, reason: 'no_plan' };
  }

  const status = data.subscription_status;
  if (status === 'active' || status === 'trialing') {
    return { ok: true, reason: 'subscription' };
  }

  // Past-due is a hard block on NEW audits. Existing in-flight audits are
  // unaffected because this gate only fires on creation.
  if (status === 'past_due') {
    return { ok: false, reason: 'past_due' };
  }

  const credits = data.audit_credits ?? 0;
  if (credits > 0) {
    return { ok: true, reason: 'credit', remaining: credits };
  }

  return { ok: false, reason: 'no_plan' };
}
