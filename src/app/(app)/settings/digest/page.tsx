import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { DigestCard } from '@/components/settings/digest-card';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Digest — CarrierAudit',
};

export const dynamic = 'force-dynamic';

interface ProfileRow {
  digest_opt_out: boolean | null;
}

export default async function DigestSettingsPage(): Promise<React.ReactElement> {
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
    .select('digest_opt_out')
    .eq('id', user.id)
    .maybeSingle();
  const profile = (data ?? null) as ProfileRow | null;
  const optOut = profile?.digest_opt_out === true;

  return (
    <div className="space-y-6">
      <DigestCard initialOptOut={optOut} />
    </div>
  );
}
