'use server';

import { redirect } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { consumeRateLimit } from '@/lib/security/rate-limit';
import { createClient } from '@/lib/supabase/server';

const SignInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // M4: optional safe-next so the user lands on the page they were trying
  // to reach. Validated below — only same-origin relative paths allowed.
  next: z.string().max(512).optional(),
});

type SignInResult = { ok: false; error: string };

/**
 * Validate a `next` parameter from the login form so it can only redirect
 * to a same-origin relative path. Defends against open-redirect via
 * crafted `next=//evil.com` or `next=https://evil.com` payloads.
 *
 * Allowed:  `/`, `/dashboard`, `/audits/123?x=1#frag`
 * Refused:  empty, missing leading `/`, leading `//`, leading `/\`,
 *           any value containing a `:` (protocol-relative or absolute URL).
 */
function safeNextPath(input: string | undefined): string | null {
  if (!input) return null;
  if (input.length === 0 || input.length > 512) return null;
  if (!input.startsWith('/')) return null;
  // Reject scheme-relative `//host` and Windows-style `/\host` paths.
  if (input.startsWith('//') || input.startsWith('/\\')) return null;
  // Reject anything that looks like it carries a scheme (`/foo:bar` — the
  // colon could be misparsed by edge proxies). Cheap, safe over-rejection.
  if (input.includes(':')) return null;
  return input;
}

export async function signInAction(input: unknown): Promise<SignInResult | undefined> {
  const parsed = SignInSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid email or password.' };
  }

  // L8: throttle password attempts per-email. Supabase Auth has its own
  // throttle but it's lenient (5-10/min on free tier). 10 attempts per
  // 10 minutes is generous for a real user and tight enough to slow a
  // credential-stuffing pass through a leaked email list.
  const limit = await consumeRateLimit({
    key: `auth:login:${parsed.data.email.toLowerCase()}`,
    limit: 10,
    windowSeconds: 600,
  });
  if (!limit.ok) {
    return {
      ok: false,
      error: 'Too many sign-in attempts. Please wait a few minutes and try again.',
    };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    if (error) {
      Sentry.captureException(error, { tags: { surface: 'auth.login' } });
      return { ok: false, error: 'Invalid email or password.' };
    }

    const next = safeNextPath(parsed.data.next);
    redirect(next ?? '/dashboard');
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw err;
    Sentry.captureException(err, { tags: { surface: 'auth.login' } });
    return { ok: false, error: 'Server error. Please try again.' };
  }
}
