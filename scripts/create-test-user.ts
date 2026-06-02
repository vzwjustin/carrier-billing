/**
 * scripts/create-test-user.ts
 *
 * Create a confirmed Supabase auth user for local testing and grant audit
 * credits so the access gate (src/lib/access/gate.ts) lets them upload a
 * bill without a Stripe subscription.
 *
 * Usage:
 *   pnpm dlx tsx scripts/create-test-user.ts
 *   pnpm dlx tsx scripts/create-test-user.ts --email me@example.com
 *   pnpm dlx tsx scripts/create-test-user.ts --email me@example.com --password 'My$ecret123' --credits 5
 *
 * Notes:
 *   - Uses SUPABASE_SERVICE_ROLE_KEY; never run this from a browser surface.
 *   - Idempotent: if the email already exists in auth.users, we resolve its id
 *     instead of erroring, and we still bump credits on the profile.
 *   - The profile row is created by the public.handle_new_user trigger
 *     (supabase/migrations/0001_init.sql:261). We update it after creation.
 */

import { createClient } from '@supabase/supabase-js';

import { loadDotEnvLocal } from './lib/env-loader';

interface CliArgs {
  email: string;
  password: string;
  credits: number;
}

function parseArgs(argv: string[]): CliArgs {
  const defaults: CliArgs = {
    email: 'tester@carrieraudit.dev',
    password: 'TestPass2026!',
    credits: 10,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--email' && argv[i + 1]) {
      defaults.email = String(argv[i + 1]);
      i++;
    } else if (arg === '--password' && argv[i + 1]) {
      defaults.password = String(argv[i + 1]);
      i++;
    } else if (arg === '--credits' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n >= 0) {
        defaults.credits = Math.floor(n);
      }
      i++;
    }
  }

  if (defaults.password.length < 12) {
    throw new Error('Password must be at least 12 characters (matches signup server schema).');
  }
  return defaults;
}

async function main(): Promise<void> {
  const env = loadDotEnvLocal();
  const url = env['NEXT_PUBLIC_SUPABASE_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const serviceKey = env['SUPABASE_SERVICE_ROLE_KEY'] ?? process.env['SUPABASE_SERVICE_ROLE_KEY'];

  if (!url || !serviceKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  }

  const { email, password, credits } = parseArgs(process.argv.slice(2));
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Step 1: create the user (email_confirm=true skips the verification mail).
  let userId: string | undefined;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (created.error) {
    const msg = created.error.message.toLowerCase();
    const isDuplicate =
      msg.includes('already') || msg.includes('exists') || msg.includes('registered');
    if (!isDuplicate) {
      throw new Error(`auth.admin.createUser failed: ${created.error.message}`);
    }

    // Idempotent path: look up the existing user.
    const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (list.error) {
      throw new Error(`auth.admin.listUsers failed: ${list.error.message}`);
    }
    const found = list.data.users.find(
      (u) => (u.email ?? '').toLowerCase() === email.toLowerCase(),
    );
    if (!found) {
      throw new Error(
        `Email reported as duplicate but not found via listUsers; cannot resolve id for ${email}`,
      );
    }
    userId = found.id;

    // Reset the password so the caller's printed credentials are valid even
    // if the user existed from a prior run with a different password.
    const updated = await admin.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true,
    });
    if (updated.error) {
      throw new Error(`auth.admin.updateUserById failed: ${updated.error.message}`);
    }
    console.log(`[ok] existing user ${email} (${userId}) password reset`);
  } else {
    userId = created.data.user?.id;
    if (!userId) {
      throw new Error('createUser returned no user id');
    }
    console.log(`[ok] created user ${email} (${userId})`);
  }

  // Step 2: bump audit_credits on the profile row (created by trigger).
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .update({ audit_credits: credits })
    .eq('id', userId)
    .select('id,audit_credits,subscription_status')
    .single();

  if (profileErr || !profile) {
    throw new Error(`profiles update failed: ${profileErr?.message ?? 'no row returned'}`);
  }

  console.log('[ok] profile updated');
  console.log('');
  console.log('  Email:    ', email);
  console.log('  Password: ', password);
  console.log('  User ID:  ', userId);
  console.log('  Credits:  ', profile['audit_credits']);
  console.log('  Sub:      ', profile['subscription_status'] ?? '(none)');
  console.log('');
  console.log('Sign in at: http://localhost:3000/login');
}

main().catch((err) => {
  console.error('[fail]', err instanceof Error ? err.message : err);
  process.exit(1);
});
