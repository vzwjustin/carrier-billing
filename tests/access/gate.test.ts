import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks --------------------------------------------------------------
// Declared before importing the SUT.

type ProfileRow = {
  subscription_status: string | null;
  audit_credits: number | null;
};
type MaybeSingleResult = {
  data: ProfileRow | null;
  error: null | { message: string };
};

const maybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();

const fromMock = vi.fn((_table: string) => ({
  select: (_cols: string) => ({
    eq: (_col: string, _val: string) => ({
      maybeSingle: () => maybeSingleMock(),
    }),
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: fromMock }),
}));

// Import after mocks are registered.
import { assertCanRunAudit } from '@/lib/access/gate';

beforeEach(() => {
  maybeSingleMock.mockReset();
  fromMock.mockClear();
});

describe('assertCanRunAudit', () => {
  it('returns ok=subscription for active subscription', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { subscription_status: 'active', audit_credits: 0 },
      error: null,
    });
    const result = await assertCanRunAudit('user-1');
    expect(result).toEqual({ ok: true, reason: 'subscription' });
  });

  it('returns ok=subscription for trialing subscription', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { subscription_status: 'trialing', audit_credits: 0 },
      error: null,
    });
    const result = await assertCanRunAudit('user-1');
    expect(result).toEqual({ ok: true, reason: 'subscription' });
  });

  it('returns not ok with past_due when subscription is past_due', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { subscription_status: 'past_due', audit_credits: 5 },
      error: null,
    });
    const result = await assertCanRunAudit('user-1');
    expect(result).toEqual({ ok: false, reason: 'past_due' });
  });

  it('returns ok=credit with remaining when canceled with credits > 0', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { subscription_status: 'canceled', audit_credits: 3 },
      error: null,
    });
    const result = await assertCanRunAudit('user-1');
    expect(result).toEqual({ ok: true, reason: 'credit', remaining: 3 });
  });

  it('returns ok=credit with remaining when no subscription but credits > 0', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { subscription_status: null, audit_credits: 1 },
      error: null,
    });
    const result = await assertCanRunAudit('user-1');
    expect(result).toEqual({ ok: true, reason: 'credit', remaining: 1 });
  });

  it('returns not ok with no_plan when canceled and 0 credits', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { subscription_status: 'canceled', audit_credits: 0 },
      error: null,
    });
    const result = await assertCanRunAudit('user-1');
    expect(result).toEqual({ ok: false, reason: 'no_plan' });
  });

  it('returns not ok with no_plan when profile is missing', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const result = await assertCanRunAudit('user-1');
    expect(result).toEqual({ ok: false, reason: 'no_plan' });
  });

  it('throws when supabase errors so the caller can return 5xx (R1-3)', async () => {
    // Pre-R1-3 this returned no_plan, masking transient infra failures as
    // a paying user being blocked. The new contract is to surface the error
    // so the route's outer catch turns it into a 500.
    maybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    });
    await expect(assertCanRunAudit('user-1')).rejects.toMatchObject({
      message: 'boom',
    });
  });
});
