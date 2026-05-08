import Link from 'next/link';

import { Button } from '@/components/ui/button';

export const metadata = {
  title: 'Dashboard — CarrierAudit',
};

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-neutral-200 bg-white p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
              Welcome to CarrierAudit
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
              Upload a business wireless bill and we&apos;ll find your wasted
              spend.
            </p>
          </div>
          <Link href="/audits/new">
            <Button size="lg">Run an audit</Button>
          </Link>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium text-neutral-900">
          Your audits
        </h2>
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
          <p className="text-sm text-neutral-500">
            You haven&apos;t run any audits yet.
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            Upload your first bill to see findings here.
          </p>
        </div>
      </section>
    </div>
  );
}
