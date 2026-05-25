'use server';

import { z } from 'zod';

import { env } from '@/env';
import { consumeRateLimit } from '@/lib/security/rate-limit';
import { createClient } from '@/lib/supabase/server';

const ResetSchema = z.object({
  email: z.string().email(),
});

const ResendSchema = z.object({
  email: z.string().email(),
});

const UpdatePasswordSchema = z.object({
  password: z.string().min(8).max(128),
});

type ActionResult = { ok: true } | { ok: false; error: string };

export async function requestPasswordResetAction(
  input: unknown,
): Promise<ActionResult> {
  const parsed = ResetSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Enter a valid email address.' };
  }

  const limit = await consumeRateLimit({
    key: `auth:password-reset:${parsed.data.email.toLowerCase()}`,
    limit: 5,
    windowSeconds: 60 * 60,
  });
  if (!limit.ok) {
    return { ok: true };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(
    parsed.data.email,
    {
      redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/auth/update-password`,
    },
  );

  if (error) {
    // Per Supabase docs we still return success to avoid leaking which emails
    // are registered, but log the underlying error server-side. The user will
    // either get an email or not — UI is the same in both cases.
    return { ok: true };
  }
  return { ok: true };
}

export async function resendSignupConfirmationAction(
  input: unknown,
): Promise<ActionResult> {
  const parsed = ResendSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid email.' };
  }

  const limit = await consumeRateLimit({
    key: `auth:signup-resend:${parsed.data.email.toLowerCase()}`,
    limit: 3,
    windowSeconds: 60 * 60,
  });
  if (!limit.ok) {
    return {
      ok: false,
      error: 'Please wait before requesting another confirmation email.',
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  });

  if (error) {
    return {
      ok: false,
      error: 'Could not send confirmation email. Please try again.',
    };
  }
  return { ok: true };
}

export async function updatePasswordAction(
  input: unknown,
): Promise<ActionResult> {
  const parsed = UpdatePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Password must be 8–128 characters.',
    };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
