'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const ProfileSchema = z.object({
  full_name: z.string().trim().max(120).optional().nullable(),
  company_name: z.string().trim().max(120).optional().nullable(),
});

export type UpdateProfileResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateProfileAction(
  input: unknown,
): Promise<UpdateProfileResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'Not signed in.' };
  }

  const parsed = ProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid input.' };
  }

  const admin = getAdminClient();
  const { error } = await admin
    .from('profiles')
    .update({
      full_name: parsed.data.full_name?.length ? parsed.data.full_name : null,
      company_name: parsed.data.company_name?.length
        ? parsed.data.company_name
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  if (error) {
    return { ok: false, error: 'Could not save profile. Please try again.' };
  }

  revalidatePath('/settings');
  return { ok: true };
}
