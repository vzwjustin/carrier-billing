import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';

export interface AdminContext {
  userId: string;
  email: string;
}

/**
 * Server-side admin gate. Reads the caller's own profile role via the
 * RLS-scoped server client (a user can read their own row). Returns null if
 * not signed in or not an admin — callers decide whether to redirect or 404.
 *
 * Every admin entrypoint MUST call this; never trust a client-supplied role.
 */
export async function getAdminContext(): Promise<AdminContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from('profiles')
    .select('role, email')
    .eq('id', user.id)
    .maybeSingle();

  const row = (data ?? null) as { role?: string; email?: string } | null;
  if (!row || row.role !== 'admin') return null;

  return { userId: user.id, email: row.email ?? user.email ?? '' };
}

/** Redirects non-admins to the dashboard. Use in admin pages/layouts. */
export async function requireAdmin(): Promise<AdminContext> {
  const ctx = await getAdminContext();
  if (!ctx) redirect('/dashboard');
  return ctx;
}
