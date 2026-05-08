import { getAdminClient } from '@/lib/supabase/admin';

/**
 * Atomically decrement a user's `audit_credits` by 1 via the
 * `increment_audit_credits(profile_id, delta)` Postgres RPC, which performs
 * the read+write inside a single transaction so concurrent audit creations
 * cannot double-spend a credit.
 *
 * Throws `'no_credits'` if the new balance is null or negative — the caller
 * should treat this as a 402 and roll back any audit row that was already
 * inserted. The upstream `assertCanRunAudit` gate should have prevented this
 * from happening; this is the race-safety net.
 */
export async function decrementAuditCreditAtomically(
  userId: string,
): Promise<{ remaining: number }> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('increment_audit_credits', {
    profile_id: userId,
    delta: -1,
  });

  if (error) {
    throw new Error(`increment_audit_credits failed: ${error.message}`);
  }

  const remaining = coerceBalance(data);
  if (remaining === null || remaining < 0) {
    throw new Error('no_credits');
  }
  return { remaining };
}

function coerceBalance(data: unknown): number | null {
  if (data === null || data === undefined) return null;
  if (typeof data === 'number' && Number.isFinite(data)) return data;
  // Some PostgREST RPC shapes wrap the scalar — defensively unwrap one level.
  if (typeof data === 'object') {
    if (Array.isArray(data)) {
      const first = data[0];
      if (typeof first === 'number' && Number.isFinite(first)) return first;
      if (first && typeof first === 'object') {
        const inner = (first as Record<string, unknown>)[
          'increment_audit_credits'
        ];
        if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
      }
      return null;
    }
    const inner = (data as Record<string, unknown>)['increment_audit_credits'];
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
  }
  return null;
}
