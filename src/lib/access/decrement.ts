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
 *
 * @deprecated H4 — prefer `consumeAuditCreditForAudit` which is
 * idempotent per audit_id and avoids the "RPC committed but response lost"
 * credit-leak window. Retained for back-compat with any caller that doesn't
 * yet have an audit row to anchor the operation.
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

/**
 * H4: anchor the credit decrement to a specific audit row so the operation
 * is idempotent under retry.
 *
 * The `consume_audit_credit(p_audit_id, p_user_id)` RPC (migration 0018):
 *   1. Flips `audits.credit_consumed: false → true` for the given row,
 *      gated on `status='pending'` and matching `user_id`.
 *   2. If the flip succeeded, decrements `profiles.audit_credits` (with a
 *      floor guard — refuses to go negative).
 *   3. Returns `{ granted: true, new_balance }` on first call,
 *      `{ granted: false, new_balance }` on idempotent retry, and
 *      `{ granted: null, new_balance: null }` on refusal (unknown audit,
 *      no credits, or row not pending).
 *
 * Both granted=true and granted=false are success from the caller's
 * perspective — the credit is consumed exactly once for this audit.
 *
 * Throws `'no_credits'` on refusal so the caller can branch the same way
 * it does today.
 */
type ConsumeRow = { granted: boolean | null; new_balance: number | null };

export async function consumeAuditCreditForAudit(
  userId: string,
  auditId: string,
): Promise<{ remaining: number; idempotent: boolean }> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('consume_audit_credit', {
    p_audit_id: auditId,
    p_user_id: userId,
  });

  if (error) {
    throw new Error(`consume_audit_credit failed: ${error.message}`);
  }

  const row = coerceConsumeRow(data);
  if (!row || row.granted === null || row.new_balance === null) {
    throw new Error('no_credits');
  }
  return { remaining: row.new_balance, idempotent: row.granted === false };
}

function coerceConsumeRow(data: unknown): ConsumeRow | null {
  if (data === null || data === undefined) return null;
  // PostgREST returns RECORDS as an array of objects.
  if (Array.isArray(data)) {
    const first = data[0];
    if (first && typeof first === 'object') {
      return readConsumeFields(first as Record<string, unknown>);
    }
    return null;
  }
  if (typeof data === 'object') {
    return readConsumeFields(data as Record<string, unknown>);
  }
  return null;
}

function readConsumeFields(obj: Record<string, unknown>): ConsumeRow | null {
  const grantedRaw = obj['granted'];
  const balanceRaw = obj['new_balance'];
  const granted =
    grantedRaw === null || grantedRaw === undefined
      ? null
      : typeof grantedRaw === 'boolean'
        ? grantedRaw
        : undefined;
  const new_balance =
    balanceRaw === null || balanceRaw === undefined
      ? null
      : typeof balanceRaw === 'number' && Number.isFinite(balanceRaw)
        ? balanceRaw
        : undefined;
  if (granted === undefined || new_balance === undefined) return null;
  return { granted, new_balance };
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
