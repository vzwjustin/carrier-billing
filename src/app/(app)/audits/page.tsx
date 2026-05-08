import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { cn, formatCents } from '@/lib/utils';

export const metadata = {
  title: 'Audits — CarrierAudit',
};

export const dynamic = 'force-dynamic';

interface AuditListRow {
  id: string;
  created_at: string;
  original_filename: string;
  carrier: string | null;
  status: string;
  estimated_annual_savings_cents: number | null;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-neutral-100 text-neutral-700',
  extracting: 'bg-blue-100 text-blue-700',
  analyzing: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  extracting: 'Extracting',
  analyzing: 'Analyzing',
  completed: 'Completed',
  failed: 'Failed',
};

const CARRIER_LABELS: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  unknown: 'Unknown',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const cls = STATUS_STYLES[status] ?? 'bg-neutral-100 text-neutral-700';
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        cls,
      )}
    >
      {label}
    </span>
  );
}

export default async function AuditsPage(): Promise<React.JSX.Element> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('audits')
    .select(
      'id,created_at,original_filename,carrier,status,estimated_annual_savings_cents',
    )
    .order('created_at', { ascending: false })
    .limit(50)
    .returns<AuditListRow[]>();

  const rows = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Your audits
        </h1>
        <Link href="/audits/new">
          <Button>New audit</Button>
        </Link>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          We couldn&apos;t load your audits. Please refresh the page.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
          <p className="text-sm text-neutral-700">
            No audits yet. Upload your first bill.
          </p>
          <div className="mt-4">
            <Link href="/audits/new">
              <Button>Upload a bill</Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">Carrier</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Annual savings</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3 text-neutral-700">
                    {formatDate(row.created_at)}
                  </td>
                  <td className="px-4 py-3 text-neutral-900">
                    <span className="block max-w-xs truncate">
                      {row.original_filename}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-neutral-700">
                    {row.carrier ? CARRIER_LABELS[row.carrier] ?? row.carrier : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-3 text-neutral-900">
                    {row.estimated_annual_savings_cents !== null &&
                    row.estimated_annual_savings_cents > 0
                      ? formatCents(row.estimated_annual_savings_cents)
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/audits/${row.id}`}
                      className="text-sm font-medium text-neutral-900 hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
