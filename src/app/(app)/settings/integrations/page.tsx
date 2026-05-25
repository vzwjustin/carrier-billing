import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { InboundEmailCard } from '@/components/settings/inbound-email-card';
import { InboundWebhookCard } from '@/components/settings/inbound-webhook-card';
import { OutboundWebhookCard } from '@/components/settings/outbound-webhook-card';
import { SlackCard } from '@/components/settings/slack-card';
import { env } from '@/env';
import { getOrCreateInboundToken } from '@/lib/inbound/token';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Integrations — CarrierAudit',
};

export const dynamic = 'force-dynamic';

interface ProfileRow {
  outbound_webhook_url: string | null;
  outbound_webhook_secret: string | null;
  // secret stays server-side: only a boolean flag crosses the RSC boundary
  inbound_webhook_token: string | null;
  slack_webhook_url: string | null;
  slack_notify_on_high_finding: boolean | null;
  slack_notify_on_autopsy: boolean | null;
}

export default async function IntegrationsSettingsPage(): Promise<React.ReactElement> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const admin = getAdminClient();
  const inboundDomain = env.INBOUND_EMAIL_DOMAIN ?? null;

  // Only mint a token when inbound is actually configured. Otherwise the user
  // sees the "not enabled" copy and we don't bloat the profiles table with
  // tokens that go nowhere.
  let inboundToken: string | null = null;
  if (inboundDomain) {
    inboundToken = await getOrCreateInboundToken(admin, user.id);
  }

  const { data } = await admin
    .from('profiles')
    .select(
      'outbound_webhook_url, outbound_webhook_secret, inbound_webhook_token, slack_webhook_url, slack_notify_on_high_finding, slack_notify_on_autopsy',
    )
    .eq('id', user.id)
    .maybeSingle();
  const profile = (data ?? null) as ProfileRow | null;

  return (
    <div className="space-y-6">
      <InboundEmailCard
        domain={inboundDomain}
        initialToken={inboundToken}
      />
      <OutboundWebhookCard
        initialUrl={profile?.outbound_webhook_url ?? null}
        hasSecret={typeof profile?.outbound_webhook_secret === 'string' && profile.outbound_webhook_secret.length > 0}
      />
      <InboundWebhookCard
        initialToken={profile?.inbound_webhook_token ?? null}
      />
      <SlackCard
        initialWebhookUrl={profile?.slack_webhook_url ?? null}
        initialNotifyOnHighFinding={profile?.slack_notify_on_high_finding ?? true}
        initialNotifyOnAutopsy={profile?.slack_notify_on_autopsy ?? true}
      />
    </div>
  );
}
