import { beforeEach, describe, expect, it, vi } from 'vitest';

type ProfileResult =
  | {
      data: {
        full_name: string | null;
        company_name: string | null;
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

vi.mock('@/components/settings/account-form', () => ({
  AccountForm: () => null,
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

import AccountSettingsPage from '@/app/(app)/settings/page';

beforeEach(() => {
  getUserMock.mockClear();
  profileMaybeSingleMock.mockReset();
});

describe('AccountSettingsPage', () => {
  it('throws instead of rendering an empty account form when profile loading fails', async () => {
    profileMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(AccountSettingsPage()).rejects.toThrow(
      'Failed to load account profile: database unavailable',
    );
  });
});
