'use server';

import { redirect } from 'next/navigation';
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
      return { ok: false, error: error.message };
    }

    redirect('/dashboard');
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Server error: ${msg}` };
  }
}
