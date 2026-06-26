import { describe, expect, it, vi, beforeEach } from 'vitest';

type ProfileResult =
  | {
      data: {
        outbound_webhook_url: string | null;
        outbound_webhook_secret: string | null;
      } | null;
      error: null;
    }
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

vi.mock('@/components/settings/inbound-email-card', () => ({
  InboundEmailCard: () => null,
}));

vi.mock('@/components/settings/outbound-webhook-card', () => ({
  OutboundWebhookCard: () => null,
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

vi.mock('@/lib/inbound/token', () => ({
  getOrCreateInboundToken: vi.fn(async () => 'inbound-token'),
}));

vi.mock('@/env', () => ({
  env: { INBOUND_EMAIL_DOMAIN: null },
}));

import IntegrationsSettingsPage from '@/app/(app)/settings/integrations/page';

beforeEach(() => {
  getUserMock.mockClear();
  profileMaybeSingleMock.mockReset();
});

describe('IntegrationsSettingsPage', () => {
  it('throws instead of rendering an empty webhook form when profile loading fails', async () => {
    profileMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(IntegrationsSettingsPage()).rejects.toThrow(
      'Failed to load integrations profile: database unavailable',
    );
  });
});
