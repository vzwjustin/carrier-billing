'use server';

import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { env } from '@/env';
import { createClient } from '@/lib/supabase/server';

const SignUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(128),
});

type SignUpResult = { ok: true } | { ok: false; error: string };

export async function signUpAction(input: unknown): Promise<SignUpResult> {
  const parsed = SignUpSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid email or password.' };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      },
    });

    if (error) {
      Sentry.captureException(error, { tags: { surface: 'auth.signup' } });
      return { ok: false, error: 'Could not sign up. Please try again.' };
    }

    return { ok: true };
  } catch (err) {
    Sentry.captureException(err, { tags: { surface: 'auth.signup' } });
    return { ok: false, error: 'Server error. Please try again.' };
  }
}
