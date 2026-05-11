import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R2-F5 — `copyOutboundWebhookSecretAction` rate-limit.
 *
 * Before this fix, the server action returned the plaintext webhook signing
 * secret on every call with no throttle, so a post-XSS or session-hijack
 * attacker could exfiltrate the secret via repeated calls. Migration 0015
 * added `profiles.last_secret_reveal_at`; the action now enforces a per-user
 * 1-second cooldown.
 */

const userId = 'user_secret_owner';
let storedSecret: string | null = 'whs_abcdef0123456789';
let lastRevealAt: string | null = null;

const getUserMock = vi.fn(async () => ({
  data: { user: { id: userId } },
  error: null,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

const adminFromMock = vi.fn(() => ({
  select: () => ({
    eq: () => ({
      maybeSingle: async () => ({
        data: {
          outbound_webhook_secret: storedSecret,
          last_secret_reveal_at: lastRevealAt,
        },
        error: null,
      }),
    }),
  }),
  update: (patch: Record<string, unknown>) => ({
    eq: async (_col: string, _val: string) => {
      if ('last_secret_reveal_at' in patch) {
        lastRevealAt = patch['last_secret_reveal_at'] as string | null;
      }
      return { error: null };
    },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: adminFromMock }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => undefined,
}));

import { copyOutboundWebhookSecretAction } from '@/app/(app)/settings/actions';

beforeEach(() => {
  storedSecret = 'whs_abcdef0123456789';
  lastRevealAt = null;
  getUserMock.mockClear();
  adminFromMock.mockClear();
});

describe('copyOutboundWebhookSecretAction — R2-F5 cooldown', () => {
  it('first call returns the plaintext secret and records last_secret_reveal_at', async () => {
    const result = await copyOutboundWebhookSecretAction();
    expect(result).toEqual({ ok: true, secret: 'whs_abcdef0123456789' });
    expect(typeof lastRevealAt).toBe('string');
  });

  it('second call within 1s returns cooldown error, secret not exposed', async () => {
    // First call records a fresh reveal timestamp.
    const first = await copyOutboundWebhookSecretAction();
    expect(first).toEqual({ ok: true, secret: 'whs_abcdef0123456789' });

    // Second call within the 1-second cooldown window must be rejected.
    const second = await copyOutboundWebhookSecretAction();
    expect(second).toEqual({
      ok: false,
      error: 'Please wait a moment before revealing again.',
    });
  });

  it('call after the cooldown window returns the secret again', async () => {
    // Pre-seed a reveal timestamp from 2 seconds ago — past the 1s window.
    lastRevealAt = new Date(Date.now() - 2_000).toISOString();
    const result = await copyOutboundWebhookSecretAction();
    expect(result).toEqual({ ok: true, secret: 'whs_abcdef0123456789' });
  });

  it('unauthenticated caller returns Not-signed-in without touching the row', async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: null },
      error: null,
    } as never);
    const result = await copyOutboundWebhookSecretAction();
    expect(result).toEqual({ ok: false, error: 'Not signed in.' });
    expect(adminFromMock).not.toHaveBeenCalled();
  });

  it('no secret configured returns explicit error (cooldown not consulted)', async () => {
    storedSecret = null;
    const result = await copyOutboundWebhookSecretAction();
    expect(result).toEqual({ ok: false, error: 'No secret configured.' });
  });
});
