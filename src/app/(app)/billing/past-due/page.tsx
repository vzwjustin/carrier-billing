import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { ManageSubscriptionButton } from '@/components/settings/billing-actions';
import { Banner } from '@/components/ui/banner';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Payment failed — CarrierAudit',
};

export const dynamic = 'force-dynamic';

interface ProfileRow {
  subscription_status: string | null;
}

export default async function PaymentFailedPage(): Promise<React.ReactElement> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  const admin = getAdminClient();
  const { data, error } = await admin
    .from('profiles')
    .select('subscription_status')
    .eq('id', user.id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load billing status: ${error.message}`);
  }

  const profile = (data ?? null) as ProfileRow | null;
  if (profile?.subscription_status !== 'past_due') {
    redirect('/dashboard');
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Payment failed</h1>
        <p className="text-sm text-neutral-600">Let&apos;s get your subscription back on track.</p>
      </header>

      <Banner
        variant="warning"
        title="Your last payment didn't go through"
        description="Your subscription is in past_due. Update your card and we'll retry the charge automatically."
      />

      <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        <ol className="space-y-6">
          <li className="flex gap-4">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white">
              1
            </span>
            <div className="space-y-2">
              <p className="text-sm font-medium text-neutral-900">Update your payment method</p>
              <p className="text-sm text-neutral-600">
                Open the Stripe customer portal to add a new card or replace the failing one. The
                portal also lists every invoice we&apos;ve tried to charge.
              </p>
              <ManageSubscriptionButton />
            </div>
          </li>
          <li className="flex gap-4">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white">
              2
            </span>
            <div className="space-y-1">
              <p className="text-sm font-medium text-neutral-900">Wait for Stripe to retry</p>
              <p className="text-sm text-neutral-600">
                Once the new payment method is saved, Stripe will retry the outstanding invoice
                within a few minutes. Your subscription reactivates automatically when the charge
                succeeds.
              </p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white">
              3
            </span>
            <div className="space-y-1">
              <p className="text-sm font-medium text-neutral-900">
                Still stuck? Reply to the email we sent
              </p>
              <p className="text-sm text-neutral-600">
                If the portal can&apos;t recover the charge — for example, because the card is
                permanently declined — reply to our payment-failed email and we&apos;ll sort it out.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <Link
        href="/dashboard"
        className="inline-block text-sm text-neutral-500 hover:text-neutral-900"
      >
        ← Return to dashboard
      </Link>
    </div>
  );
}
