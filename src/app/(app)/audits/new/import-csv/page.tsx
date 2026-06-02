import { redirect } from 'next/navigation';
import Link from 'next/link';

import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { CsvImportWizard } from '@/components/upload/csv-import-wizard';
import { assertCanRunAudit } from '@/lib/access/gate';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Import CSV — CarrierAudit',
};

export const dynamic = 'force-dynamic';

export default async function ImportCsvPage(): Promise<React.JSX.Element> {
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
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Import CSV</h1>
        </div>
        <Banner
          variant="warning"
          title="Subscription past due"
          description="Your subscription is past due, so we can't start a new audit right now. Please update your payment method to continue."
          action={{ label: 'Update payment', href: '/billing/past-due' }}
        />
      </div>
    );
  }

  if (!gate.ok) {
    return (
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Import CSV</h1>
          <p className="mt-1 text-sm text-neutral-500">
            You need a one-time audit credit or an active subscription.
          </p>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-neutral-900">Out of credits</h2>
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

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Import CSV</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Upload a carrier line-detail CSV export. We&apos;ll map columns to the audit schema and
          run the same rules engine as the PDF flow.
        </p>
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white p-6">
        <CsvImportWizard />
      </div>
    </div>
  );
}
