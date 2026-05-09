/**
 * Concurrent decrement underflow tests.
 *
 * `decrementAuditCreditAtomically(userId)` is the race-safety net beneath the
 * Phase 4 access gate. The gate's read-then-write pattern allows two
 * audit-create requests to *both* observe `audit_credits >= 1` before either
 * decrement actually runs. The atomic RPC `increment_audit_credits` is the
 * source of truth: the second decrement must match zero rows and bubble out as
 * `'no_credits'` without mutating the ledger below zero.
 *
 * Coverage here is intentionally narrow — it picks up where the existing
 * `tests/access/decrement.test.ts` file leaves off:
 *   - simulate two concurrent decrement calls when balance starts at 1
 *   - assert exactly one succeeds with `remaining: 0`
 *   - assert exactly one throws `'no_credits'`
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks: a tiny atomic counter modeling the Postgres RPC behavior. Each
// `rpc('increment_audit_credits', { delta: -1 })` call atomically decrements
// only when the balance can cover it. If the guarded SQL UPDATE would match no
// rows, PostgREST returns a null scalar and the wrapper throws `no_credits`.
// ---------------------------------------------------------------------------

let balance = 0;

const rpcMock = vi.fn(
  async (
    name: string,
    args: { profile_id: string; delta: number },
  ): Promise<{ data: number | null; error: null }> => {
    if (name !== 'increment_audit_credits') {
      throw new Error(`unexpected rpc name: ${name}`);
    }
    if (args.delta < 0 && balance + args.delta < 0) {
      return { data: null, error: null };
    }
    // Atomic-on-paper: each matching call mutates `balance` and reads the new
    // value out in a single tick, the JS analog of SQL UPDATE ... RETURNING.
    balance += args.delta;
    return { data: balance, error: null };
  },
);

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ rpc: rpcMock }),
}));

import { decrementAuditCreditAtomically } from '@/lib/access/decrement';

beforeEach(() => {
  rpcMock.mockClear();
});

describe('decrementAuditCreditAtomically — concurrent race conditions', () => {
  it('two concurrent decrements when balance=1: one succeeds, the other throws no_credits', async () => {
    balance = 1;

    // Fire both calls in parallel via Promise.allSettled so one rejection
    // doesn't short-circuit the other.
    const [a, b] = await Promise.allSettled([
      decrementAuditCreditAtomically('user-1'),
      decrementAuditCreditAtomically('user-1'),
    ]);

    // The RPC was called twice (one per decrement attempt).
    expect(rpcMock).toHaveBeenCalledTimes(2);

    // Exactly one should resolve, exactly one should reject with no_credits.
    const fulfilled = [a, b].filter(
      (s): s is PromiseFulfilledResult<{ remaining: number }> => s.status === 'fulfilled',
    );
    const rejected = [a, b].filter((s): s is PromiseRejectedResult => s.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect(fulfilled[0]?.value).toEqual({ remaining: 0 });
    const reason = rejected[0]?.reason;
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe('no_credits');

    // Final ledger state stays at 0; the RPC guard prevents underflow.
    expect(balance).toBe(0);
  });

  it('three concurrent decrements when balance=1: only one succeeds, two throw no_credits', async () => {
    balance = 1;

    const settled = await Promise.allSettled([
      decrementAuditCreditAtomically('user-1'),
      decrementAuditCreditAtomically('user-1'),
      decrementAuditCreditAtomically('user-1'),
    ]);

    expect(rpcMock).toHaveBeenCalledTimes(3);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      expect(((r as PromiseRejectedResult).reason as Error).message).toBe('no_credits');
    }
  });

  it('sequential decrement after the credit is exhausted throws no_credits', async () => {
    balance = 1;

    const first = await decrementAuditCreditAtomically('user-1');
    expect(first).toEqual({ remaining: 0 });

    await expect(decrementAuditCreditAtomically('user-1')).rejects.toThrow('no_credits');

    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('balance starts at 0: first call already throws no_credits (no underflow into UX)', async () => {
    balance = 0;
    await expect(decrementAuditCreditAtomically('user-1')).rejects.toThrow('no_credits');
    expect(balance).toBe(0);
  });

  it('uses vi.spyOn-style observation: every call passes profile_id + delta=-1', async () => {
    balance = 5;
    await decrementAuditCreditAtomically('user-42');
    await decrementAuditCreditAtomically('user-42');

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock).toHaveBeenNthCalledWith(1, 'increment_audit_credits', {
      profile_id: 'user-42',
      delta: -1,
    });
    expect(rpcMock).toHaveBeenNthCalledWith(2, 'increment_audit_credits', {
      profile_id: 'user-42',
      delta: -1,
    });
  });
});
