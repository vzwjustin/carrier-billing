'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { getAdminContext } from '@/lib/admin/guard';
import { getAdminClient } from '@/lib/supabase/admin';

export type AdminActionResult =
  | { ok: true }
  | { ok: false; error: string };

const SetRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['user', 'admin']),
});

export async function setUserRoleAction(
  input: unknown,
): Promise<AdminActionResult> {
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, error: 'Not authorized.' };

  const parsed = SetRoleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  // Guard against an admin removing their own admin rights and locking the
  // panel out from under themselves.
  if (parsed.data.userId === ctx.userId && parsed.data.role !== 'admin') {
    return { ok: false, error: 'You cannot remove your own admin role.' };
  }

  const admin = getAdminClient();
  const { error } = await admin
    .from('profiles')
    .update({ role: parsed.data.role, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.userId);

  if (error) return { ok: false, error: 'Could not update role.' };
  revalidatePath('/admin/users');
  return { ok: true };
}
