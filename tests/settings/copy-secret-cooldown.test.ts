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
let revealUpdateError: { message: string } | null = null;
let existingSecretReadError: { message: string } | null = null;
let savedWebhookPatch: Record<string, unknown> | null = null;
let updateMatchCount = 1;

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
  select: (columns: string) => ({
    eq: () => ({
      maybeSingle: async () => ({
        data:
          columns === 'outbound_webhook_secret'
            ? { outbound_webhook_secret: storedSecret }
            : {
                outbound_webhook_secret: storedSecret,
                last_secret_reveal_at: lastRevealAt,
              },
        error: columns === 'outbound_webhook_secret' ? existingSecretReadError : null,
      }),
    }),
  }),
  update: (patch: Record<string, unknown>) => {
    const run = async () => {
      if ('last_secret_reveal_at' in patch) {
        if (revealUpdateError) {
          return { data: null, error: revealUpdateError };
        }
        if (updateMatchCount === 1) {
          lastRevealAt = patch['last_secret_reveal_at'] as string | null;
        }
        return {
          data: updateMatchCount === 1 ? [{ id: userId }] : [],
          error: null,
        };
      }
      if (updateMatchCount === 1) {
        savedWebhookPatch = patch;
      }
      return {
        data: updateMatchCount === 1 ? [{ id: userId }] : [],
        error: null,
      };
    };
    const builder = {
      eq: (_col: string, _val: string) => builder,
      select: (_cols: string) => run(),
      then: (
        resolve: (value: {
          data: Array<{ id: string }> | null;
          error: { message: string } | null;
        }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => run().then(resolve, reject),
    };
    return builder;
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: adminFromMock }),
}));

vi.mock('@/lib/security/ssrf-guard', () => ({
  assertPublicHttpsTarget: vi.fn(async () => undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => undefined,
}));

import {
  copyOutboundWebhookSecretAction,
  updateOutboundWebhookAction,
} from '@/app/(app)/settings/actions';

beforeEach(() => {
  storedSecret = 'whs_abcdef0123456789';
  lastRevealAt = null;
  revealUpdateError = null;
  existingSecretReadError = null;
  savedWebhookPatch = null;
  updateMatchCount = 1;
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

  it('fails closed when the reveal timestamp cannot be recorded', async () => {
    revealUpdateError = { message: 'database unavailable' };

    const result = await copyOutboundWebhookSecretAction();

    expect(result).toEqual({
      ok: false,
      error: 'Could not retrieve secret.',
    });
    expect(lastRevealAt).toBeNull();
  });

  it('fails closed when the reveal timestamp update matches no profile row', async () => {
    updateMatchCount = 0;

    const result = await copyOutboundWebhookSecretAction();

    expect(result).toEqual({
      ok: false,
      error: 'Could not retrieve secret.',
    });
    expect(lastRevealAt).toBeNull();
  });

  it('does not rotate the webhook signing secret when the existing secret lookup fails', async () => {
    existingSecretReadError = { message: 'read failed' };

    const result = await updateOutboundWebhookAction({
      outbound_webhook_url: 'https://example.com/webhook',
    });

    expect(result).toEqual({ ok: false, error: 'Could not save webhook.' });
    expect(savedWebhookPatch).toBeNull();
  });

  it('does not report webhook save success when the update matches no profile row', async () => {
    updateMatchCount = 0;

    const result = await updateOutboundWebhookAction({
      outbound_webhook_url: 'https://example.com/webhook',
    });

    expect(result).toEqual({ ok: false, error: 'Could not save webhook.' });
    expect(savedWebhookPatch).toBeNull();
  });
});
