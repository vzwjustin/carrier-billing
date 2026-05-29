import * as React from 'react';

import { formatIsoDatePeriod } from '@/lib/dates';
import type { ReportAudit } from '@/reports/types';
import { formatCents } from '@/lib/utils';

const CARRIER_LABELS: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  unknown: 'Unknown',
};

export interface BillSummaryProps {
  audit: ReportAudit;
}

export function BillSummary({ audit }: BillSummaryProps): React.JSX.Element {
  const carrier = audit.carrier ?? 'unknown';
  const carrierLabel = CARRIER_LABELS[carrier] ?? carrier;

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-600">
        Bill summary
      </h2>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <SummaryItem label="Carrier" value={carrierLabel} />
        <SummaryItem
          label="Billing period"
          value={formatIsoDatePeriod(
            audit.billing_period_start,
            audit.billing_period_end,
          )}
        />
        <SummaryItem
          label="Total charges"
          value={
            audit.total_charges_cents !== null
              ? formatCents(audit.total_charges_cents)
              : '—'
          }
        />
        <SummaryItem label="Accounts" value={String(audit.account_count)} />
        <SummaryItem label="Lines" value={String(audit.line_count)} />
      </dl>
    </section>
  );
}

function SummaryItem({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </dt>
      <dd className="mt-1 text-base font-medium text-neutral-900">{value}</dd>
    </div>
  );
}
