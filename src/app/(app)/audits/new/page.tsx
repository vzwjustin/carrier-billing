import { redirect } from 'next/navigation';
import Link from 'next/link';

import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { UploadForm } from '@/components/upload/upload-form';
import { assertCanRunAudit } from '@/lib/access/gate';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'New audit — CarrierAudit',
};

export const dynamic = 'force-dynamic';

export default async function NewAuditPage(): Promise<React.JSX.Element> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const gate = await assertCanRunAudit(user.id);

  if (!gate.ok && gate.reason === 'past_due') {
    return (
      <div className="mx-auto max-w-2xl space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            New audit
          </h1>
        </div>
        <Banner
          variant="warning"
          title="Subscription past due"
          description="Your subscription is past due, so we can't start a new audit right now. Please update your payment method to continue. In-flight audits will still finish."
          action={{ label: 'Update payment', href: '/billing/past-due' }}
        />
      </div>
    );
  }

  if (!gate.ok) {
    // Reason is 'no_plan' here (past_due handled above).
    return (
      <div className="mx-auto max-w-2xl space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            New audit
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            You need a one-time audit credit or an active subscription to run
            an audit.
          </p>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-neutral-900">
            Out of credits
          </h2>
          <p className="mt-2 text-sm text-neutral-600">
            Buy a one-time audit for $149, or subscribe for $99/mo and audit
            unlimited bills.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/pricing">
              <Button>Buy credits</Button>
            </Link>
            <Link href="/pricing">
              <Button variant="outline">Subscribe</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // gate.ok === true — narrow to either subscription or credit.
  const banner =
    gate.reason === 'subscription' ? (
      <Banner
        variant="success"
        title="Unlimited subscription active"
        description="Run as many audits as you need."
      />
    ) : (
      <Banner
        variant="info"
        title={`${gate.remaining} credit${gate.remaining === 1 ? '' : 's'} remaining`}
        description="Each audit uses one credit."
      />
    );

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          New audit
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Drop a PDF of a Verizon, AT&amp;T, or T-Mobile business wireless bill.
          We&apos;ll have results in under 5 minutes.
        </p>
      </div>

      {banner}

      <div className="rounded-lg border border-neutral-200 bg-white p-6">
        <UploadForm />
      </div>

      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-5">
        <h2 className="text-sm font-semibold text-neutral-900">
          What happens next
        </h2>
        <ol className="mt-3 space-y-2 text-sm text-neutral-700">
          <li className="flex gap-3">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white">
              1
            </span>
            <span>
              We parse every line, plan, credit, and device-payment installment
              from your PDF.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white">
              2
            </span>
            <span>
              Ten rules run against the bill — expired promos, paid-off device
              installments, plan mismatches, suspended lines billing, and more.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white">
              3
            </span>
            <span>
              You get a PDF report you can hand to your account rep with
              concrete asks and dollar amounts.
            </span>
          </li>
        </ol>
        <p className="mt-3 text-xs text-neutral-500">
          We never contact your carrier. Phone numbers are masked to last-4.
          Your file stays in your account.
        </p>
      </div>
    </div>
  );
}
