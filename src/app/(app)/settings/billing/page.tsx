import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { ManageSubscriptionButton } from '@/components/settings/billing-actions';
import { Button } from '@/components/ui/button';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Billing — CarrierAudit',
};

export const dynamic = 'force-dynamic';

interface ProfileRow {
  audit_credits: number | null;
  subscription_status: string | null;
  stripe_customer_id: string | null;
  cancel_at_period_end: boolean | null;
  current_period_end: string | null;
}

function formatPeriodEnd(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default async function BillingSettingsPage(): Promise<React.ReactElement> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  // Read via admin client so we don't have to think about RLS for this read;
  // we're already gated on `user` above.
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('profiles')
    .select(
      'audit_credits, subscription_status, stripe_customer_id, cancel_at_period_end, current_period_end',
    )
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load billing profile: ${error.message}`);
  }

  const profile = (data ?? null) as ProfileRow | null;
  const credits = profile?.audit_credits ?? 0;
  const status = profile?.subscription_status ?? null;
  const isSubscribed = status === 'active' || status === 'trialing';
  const cancelAtPeriodEnd = profile?.cancel_at_period_end ?? false;
  const periodEndIso = profile?.current_period_end ?? null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Billing</h1>
        <p className="text-sm text-neutral-600">
          Manage your CarrierAudit plan and review your remaining audit credits.
        </p>
      </header>

      <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        {isSubscribed ? (
          <SubscribedState
            status={status ?? 'active'}
            cancelAtPeriodEnd={cancelAtPeriodEnd}
            periodEndIso={periodEndIso}
          />
        ) : status === 'past_due' ? (
          <PastDueState />
        ) : credits > 0 ? (
          <CreditsState credits={credits} />
        ) : (
          <NoPlanState />
        )}
      </section>
    </div>
  );
}

function SubscribedState({
  status,
  cancelAtPeriodEnd,
  periodEndIso,
}: {
  status: string;
  cancelAtPeriodEnd: boolean;
  periodEndIso: string | null;
}): React.ReactElement {
  const periodEnd = formatPeriodEnd(periodEndIso);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium text-green-700">Unlimited subscription — {status}</p>
        <p className="mt-1 text-sm text-neutral-600">
          You have unlimited audits. Manage payment method, invoices, or cancellation in the
          customer portal.
        </p>
      </div>
      {cancelAtPeriodEnd && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Cancellation scheduled</p>
          <p className="mt-1">
            Your subscription will end{' '}
            {periodEnd ? (
              <>
                on <strong>{periodEnd}</strong>
              </>
            ) : (
              'at the end of the current billing period'
            )}
            . Until then you keep unlimited access. Re-activate any time in the customer portal.
          </p>
        </div>
      )}
      <ManageSubscriptionButton />
    </div>
  );
}

function PastDueState(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium text-amber-700">Subscription past due</p>
        <p className="mt-1 text-sm text-neutral-600">
          We could not collect your most recent payment. Update your payment method in the customer
          portal to keep your subscription active.
        </p>
      </div>
      <ManageSubscriptionButton />
    </div>
  );
}

function CreditsState({ credits }: { credits: number }): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium text-neutral-900">
          You have {credits} audit credit{credits === 1 ? '' : 's'}.
        </p>
        <p className="mt-1 text-sm text-neutral-600">
          Want unlimited audits and monthly drift alerts? Upgrade to the subscription plan.
        </p>
      </div>
      <Link href="/pricing">
        <Button>Upgrade to unlimited</Button>
      </Link>
    </div>
  );
}

function NoPlanState(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium text-neutral-900">No active plan</p>
        <p className="mt-1 text-sm text-neutral-600">
          Buy a single audit for $149 or start an unlimited subscription at $99/month.
        </p>
      </div>
      <Link href="/pricing">
        <Button>View pricing</Button>
      </Link>
    </div>
  );
}
