import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupOrphanAuditsFn,
  refundOrphanAudit,
  type OrphanRow,
} from '@/inngest/functions/cleanup-orphan-audits';
import { functions } from '@/inngest/functions';

/**
 * Tests for the cleanup-orphan-audits cron function.
 *
 * Two layers:
 *   1. Structural smoke tests — pin the public surface so a refactor doesn't
 *      accidentally break Inngest wiring.
 *   2. Behavioral test on `refundOrphanAudit` — verifies the single
 *      `refund_orphan_audit` RPC call shape (replaces the previous two-step
 *      `increment_audit_credits` + `audits.update` pattern, which could leak a
 *      credit on partial failure). The RPC is mocked at the supabase client
 *      boundary.
 */

describe('cleanupOrphanAuditsFn (structural)', () => {
  it('has id "cleanup-orphan-audits"', () => {
    const id = cleanupOrphanAuditsFn.id();
    expect(id).toContain('cleanup-orphan-audits');
  });

  it('is exported from the functions registry', () => {
    expect(functions).toContain(cleanupOrphanAuditsFn);
  });

  it('exposes a stable name', () => {
    expect(typeof cleanupOrphanAuditsFn.name).toBe('string');
    expect(cleanupOrphanAuditsFn.name.length).toBeGreaterThan(0);
  });

  it('fail-subscription-orphans sweep excludes retried audits (retry_count=0)', () => {
    const fn = cleanupOrphanAuditsFn as unknown as { fn?: unknown };
    const handlerSource =
      typeof fn.fn === 'function' ? (fn.fn as () => unknown).toString() : String(cleanupOrphanAuditsFn);
    const block = handlerSource.slice(
      handlerSource.indexOf('fail-subscription-orphans'),
      handlerSource.indexOf('return { processed:'),
    );
    expect(block).toMatch(/\.eq\(['"]retry_count['"]\s*,\s*0\)/);
  });
});

// --- refundOrphanAudit ----------------------------------------------------

type RpcResult = { data: unknown; error: null | { message: string } };
type RpcMock = ReturnType<
  typeof vi.fn<(name: string, args: Record<string, unknown>) => Promise<RpcResult>>
>;

function makeSupabaseStub(rpcMock: RpcMock) {
  // Cast through `unknown` because we only exercise `.rpc()` here — the rest
  // of the SupabaseClient surface is irrelevant to this unit.
  return { rpc: rpcMock } as unknown as Parameters<typeof refundOrphanAudit>[0];
}

const ORPHAN: OrphanRow = {
  id: 'audit-123',
  user_id: 'user-abc',
  created_at: '2026-05-08T00:00:00.000Z',
};

describe('refundOrphanAudit', () => {
  let rpcMock: RpcMock;

  beforeEach(() => {
    rpcMock = vi.fn();
  });

  it('calls refund_orphan_audit exactly once with p_audit_id, p_user_id, p_reason', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });

    await refundOrphanAudit(makeSupabaseStub(rpcMock), ORPHAN);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('refund_orphan_audit', {
      p_audit_id: ORPHAN.id,
      p_user_id: ORPHAN.user_id,
      p_reason: 'upload-not-finalized',
    });
  });

  it('does NOT make a second DB call (atomic single-RPC contract)', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });

    await refundOrphanAudit(makeSupabaseStub(rpcMock), ORPHAN);

    // One call, period — replaces the legacy two-step
    // (increment_audit_credits + audits.update) pattern.
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the RPC returns an error so Inngest retries the step', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection lost' },
    });

    await expect(
      refundOrphanAudit(makeSupabaseStub(rpcMock), ORPHAN),
    ).rejects.toThrow(/refund_orphan_audit failed: connection lost/);
  });
});
