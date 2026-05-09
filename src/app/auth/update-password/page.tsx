import Link from 'next/link';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';

import { UpdatePasswordForm } from './update-password-form';

export const metadata = {
  title: 'Set a new password — CarrierAudit',
};

export const dynamic = 'force-dynamic';

export default async function UpdatePasswordPage() {
  // The user lands here after clicking the password-reset email link, which
  // routes through /auth/callback and exchanges the code for a session before
  // sending them here. If there is no session we can't update the password.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/reset-password');
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="text-xl font-semibold tracking-tight text-neutral-900"
          >
            CarrierAudit
          </Link>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-8 shadow-sm">
          <div className="space-y-6">
            <div className="space-y-2 text-center">
              <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
                Set a new password
              </h1>
              <p className="text-sm text-neutral-500">
                Choose a new password for your account.
              </p>
            </div>
            <UpdatePasswordForm />
          </div>
        </div>
      </div>
    </main>
  );
}
