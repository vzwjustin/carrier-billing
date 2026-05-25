import { beforeEach, describe, expect, it, vi } from 'vitest';

type ProfileResult =
  | {
      data: {
        audit_credits: number | null;
        subscription_status: string | null;
      } | null;
      error: null;
    }
  | { data: null; error: { message: string } };

const getUserMock = vi.fn(async () => ({
  data: { user: { id: 'user-uuid-1', email: 'user@example.com' } },
  error: null,
}));
const profileMaybeSingleMock = vi.fn<() => Promise<ProfileResult>>();

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

vi.mock('@/components/app-nav/mobile-nav', () => ({
  MobileNav: () => null,
}));

vi.mock('@/components/ui/banner', () => ({
  Banner: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => profileMaybeSingleMock(),
        }),
      }),
    }),
  }),
}));

import AppLayout from '@/app/(app)/layout';

beforeEach(() => {
  getUserMock.mockClear();
  profileMaybeSingleMock.mockReset();
});

describe('AppLayout', () => {
  it('throws instead of rendering an out-of-credits badge when profile loading fails', async () => {
    profileMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(AppLayout({ children: <main /> })).rejects.toThrow(
      'Failed to load profile navigation state: database unavailable',
    );
  });
});
