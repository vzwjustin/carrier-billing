'use server';

import { redirect } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { createClient } from '@/lib/supabase/server';

const SignInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

type SignInResult = { ok: false; error: string };

export async function signInAction(input: unknown): Promise<SignInResult | undefined> {
  const parsed = SignInSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid email or password.' };
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

    redirect('/dashboard');
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw err;
    Sentry.captureException(err, { tags: { surface: 'auth.login' } });
    return { ok: false, error: 'Server error. Please try again.' };
  }
}
