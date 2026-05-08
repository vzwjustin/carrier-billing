// Shared helpers for the gated full-path E2E spec (tests/e2e/happy-path.spec.ts).
//
// Everything in this file is meant to run only when RUN_FULL_E2E=1. The
// helpers themselves are pure exports so the module can be imported in CI
// without crashing — the helpers only build a Supabase admin client when
// invoked, and they throw clearly if the required env is missing.
//
// We intentionally avoid importing this file at module load time from any
// non-gated spec.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Required env for the full E2E run. Read lazily so module load never fails. */
function readE2eEnv(): { url: string; serviceRoleKey: string } {
  const url = process.env.E2E_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'tests/e2e/setup.ts: E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_ROLE_KEY must be set to run the full E2E spec.',
    );
  }
  return { url, serviceRoleKey };
}

/** Returns a service-role Supabase client. Caller must ensure RUN_FULL_E2E=1. */
function adminClient(): SupabaseClient {
  const { url, serviceRoleKey } = readE2eEnv();
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Confirms a Supabase auth user via the admin API so the E2E run can log in
 * without clicking the magic link. Looks the user up by email and flips
 * `email_confirm` true.
 *
 * Throws if no matching user is found.
 */
export async function confirmUserViaAdminApi(email: string): Promise<string> {
  const supabase = adminClient();
  // listUsers paginates; we only just created the user so page 1 is fine.
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error) {
    throw new Error(`listUsers failed: ${error.message}`);
  }
  const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) {
    throw new Error(`confirmUserViaAdminApi: no user with email ${email}`);
  }
  const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
    email_confirm: true,
  });
  if (updateError) {
    throw new Error(`updateUserById failed: ${updateError.message}`);
  }
  return user.id;
}

/**
 * Best-effort cleanup: delete the auth user (cascades to profiles + audits +
 * findings via FK on delete cascade in the schema). Stripe customers created
 * during the test run are not deleted automatically — they're harmless test-
 * mode rows, but operators can delete them manually from the Stripe dashboard.
 */
export async function cleanupUser(email: string): Promise<void> {
  const supabase = adminClient();
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error) {
    throw new Error(`listUsers failed: ${error.message}`);
  }
  const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) {
    return;
  }
  const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
  if (deleteError) {
    throw new Error(`deleteUser failed: ${deleteError.message}`);
  }
}

/** Per-run unique email so concurrent runs don't collide. */
export function randomEmail(): string {
  const slug = Math.random().toString(36).slice(2, 8);
  return `e2e+${Date.now()}-${slug}@carrieraudit.test`;
}
