import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks --------------------------------------------------------------

type RpcResult = { data: unknown; error: null | { message: string } };

const rpcMock =
  vi.fn<(name: string, args: Record<string, unknown>) => Promise<RpcResult>>();

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ rpc: rpcMock }),
}));

import { decrementAuditCreditAtomically } from '@/lib/access/decrement';

beforeEach(() => {
  rpcMock.mockReset();
});

describe('decrementAuditCreditAtomically', () => {
  it('returns the new balance on success', async () => {
    rpcMock.mockResolvedValueOnce({ data: 4, error: null });

    const result = await decrementAuditCreditAtomically('user-1');
    expect(result).toEqual({ remaining: 4 });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('increment_audit_credits', {
      profile_id: 'user-1',
      delta: -1,
    });
  });

  it('treats balance of 0 as success (last credit just spent)', async () => {
    rpcMock.mockResolvedValueOnce({ data: 0, error: null });
    const result = await decrementAuditCreditAtomically('user-1');
    expect(result).toEqual({ remaining: 0 });
  });

  it("throws 'no_credits' when the new balance is negative", async () => {
    rpcMock.mockResolvedValueOnce({ data: -1, error: null });
    await expect(decrementAuditCreditAtomically('user-1')).rejects.toThrow(
      'no_credits',
    );
  });

  it("throws 'no_credits' when RPC returns null", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    await expect(decrementAuditCreditAtomically('user-1')).rejects.toThrow(
      'no_credits',
    );
  });

  it('throws when the RPC errors out', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection lost' },
    });
    await expect(decrementAuditCreditAtomically('user-1')).rejects.toThrow(
      /increment_audit_credits failed/,
    );
  });
});
