// Service-role client. Use only in trusted server-only code after explicit
// auth/ownership checks; never expose this client or key to the browser.
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '@/env';

let cached: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (cached) return cached;
  cached = createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return cached;
}
