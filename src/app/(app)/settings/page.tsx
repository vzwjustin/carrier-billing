import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { AccountForm } from '@/components/settings/account-form';
import { DangerZone } from '@/components/settings/danger-zone';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Account — CarrierAudit',
};

export const dynamic = 'force-dynamic';

interface ProfileRow {
  full_name: string | null;
  company_name: string | null;
}

export default async function AccountSettingsPage(): Promise<React.ReactElement> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  const admin = getAdminClient();
  const { data } = await admin
    .from('profiles')
    .select('full_name, company_name')
    .eq('id', user.id)
    .maybeSingle();

  const profile = (data ?? null) as ProfileRow | null;

  return (
    <div className="space-y-6">
      <section className="space-y-6 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <header className="space-y-1">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Account
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Information that appears in your reports and email greetings.
          </p>
        </header>
        <AccountForm
          email={user.email ?? ''}
          initialFullName={profile?.full_name ?? null}
          initialCompanyName={profile?.company_name ?? null}
        />
      </section>
      <DangerZone email={user.email ?? ''} />
    </div>
  );
}
