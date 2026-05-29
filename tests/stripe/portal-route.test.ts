import { beforeEach, describe, expect, it, vi } from 'vitest';

type ProfileResult =
  | { data: { stripe_customer_id: string | null } | null; error: null }
  | { data: null; error: { message: string } };

const getUserMock = vi.fn<
  () => Promise<{ data: { user: { id: string } | null } }>
>();
const profileMaybeSingleMock = vi.fn<() => Promise<ProfileResult>>();
const portalSessionsCreateMock = vi.fn<
  (args: { customer: string; return_url: string }) => Promise<{ url: string }>
>();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
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

vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    billingPortal: {
      sessions: {
        create: (args: Parameters<typeof portalSessionsCreateMock>[0]) =>
          portalSessionsCreateMock(args),
      },
    },
  }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_APP_URL: 'https://app.carrieraudit.test///',
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { POST } from '@/app/api/stripe/portal/route';

beforeEach(() => {
  getUserMock.mockReset();
  profileMaybeSingleMock.mockReset();
  portalSessionsCreateMock.mockReset();

  getUserMock.mockResolvedValue({ data: { user: { id: 'user_1' } } });
  profileMaybeSingleMock.mockResolvedValue({
    data: { stripe_customer_id: 'cus_1' },
    error: null,
  });
  portalSessionsCreateMock.mockResolvedValue({
    url: 'https://billing.stripe.com/p/session',
  });
});

describe('POST /api/stripe/portal', () => {
  it('normalizes repeated trailing slashes in NEXT_PUBLIC_APP_URL', async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(portalSessionsCreateMock).toHaveBeenCalledWith({
      customer: 'cus_1',
      return_url: 'https://app.carrieraudit.test/settings/billing',
    });
  });
});
