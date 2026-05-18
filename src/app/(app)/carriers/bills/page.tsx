import { listBillsAction } from './actions';

import { BillEditor } from '@/components/carriers/bill-editor';

export const metadata = {
  title: 'Bill Editor — CarrierAudit',
};

export const dynamic = 'force-dynamic';

export default async function CarrierBillsPage(): Promise<React.JSX.Element> {
  const bills = await listBillsAction();

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Bill editor
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Manually build or adjust a carrier bill, model an optimized plan
          line-by-line, and compare current vs. optimized. Export to CSV when
          you&apos;re done.
        </p>
      </header>
      <BillEditor initial={bills} />
    </div>
  );
}
