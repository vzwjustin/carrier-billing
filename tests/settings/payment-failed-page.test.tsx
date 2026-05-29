import { beforeEach, describe, expect, it, vi } from 'vitest';

type ProfileResult =
  | { data: { subscription_status: string | null } | null; error: null }
  | { data: null; error: { message: string } };

const getUserMock = vi.fn(async () => ({
  data: { user: { id: 'user-uuid-1' } },
  error: null,
}));
const profileMaybeSingleMock = vi.fn<() => Promise<ProfileResult>>();

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

vi.mock('@/components/settings/billing-actions', () => ({
  ManageSubscriptionButton: () => null,
}));

vi.mock('@/components/ui/banner', () => ({
  Banner: () => null,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => profileMaybeSingleMock(),
        }),
      }),
    }),
  }),
}));

import PaymentFailedPage from '@/app/(app)/billing/past-due/page';

beforeEach(() => {
  getUserMock.mockClear();
  profileMaybeSingleMock.mockReset();
});

describe('PaymentFailedPage', () => {
  it('throws instead of redirecting away when billing status loading fails', async () => {
    profileMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(PaymentFailedPage()).rejects.toThrow(
      'Failed to load billing status: database unavailable',
    );
  });
});
