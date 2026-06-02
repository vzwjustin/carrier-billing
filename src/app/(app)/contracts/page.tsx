import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { formatIsoDateDisplay } from '@/lib/dates';
import { cn } from '@/lib/utils';

export const metadata = {
  title: 'Contracts — CarrierAudit',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

interface ContractListRow {
  id: string;
  created_at: string;
  original_filename: string;
  carrier: string | null;
  ban_last4: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  status: string;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-neutral-100 text-neutral-700',
  extracting: 'bg-blue-100 text-blue-700',
  parsed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued',
  extracting: 'Extracting',
  parsed: 'Parsed',
  failed: 'Failed',
};

const CARRIER_LABELS: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  unknown: 'Unknown',
};

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const cls = STATUS_STYLES[status] ?? 'bg-neutral-100 text-neutral-700';
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', cls)}
    >
      {label}
    </span>
  );
}

export default async function ContractsPage(): Promise<React.JSX.Element> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('contracts')
    .select(
      'id,created_at,original_filename,carrier,ban_last4,effective_date,expiration_date,status',
    )
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE)
    .returns<ContractListRow[]>();

  const rows = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Contracts</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Upload carrier contracts, quotes, or promo sheets. Extracted terms drive
            contract-vs-bill audit findings.
          </p>
        </div>
        <Link href="/contracts/new">
          <Button>Upload contract</Button>
        </Link>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          We couldn&apos;t load your contracts. Please refresh the page.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
          <p className="text-sm text-neutral-700">
            No contracts yet. Upload your first carrier contract.
          </p>
          <div className="mt-4">
            <Link href="/contracts/new">
              <Button>Upload contract</Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-medium tracking-wide text-neutral-500 uppercase">
              <tr>
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">Carrier</th>
                <th className="px-4 py-3">BAN (last 4)</th>
                <th className="px-4 py-3">Effective</th>
                <th className="px-4 py-3">Expires</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3 text-neutral-900">
                    <span className="block max-w-xs truncate">{row.original_filename}</span>
                  </td>
                  <td className="px-4 py-3 text-neutral-700">
                    {row.carrier ? (CARRIER_LABELS[row.carrier] ?? row.carrier) : '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-neutral-700">
                    {row.ban_last4 ? `…${row.ban_last4}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-neutral-700">
                    {formatIsoDateDisplay(row.effective_date)}
                  </td>
                  <td className="px-4 py-3 text-neutral-700">
                    {formatIsoDateDisplay(row.expiration_date)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/contracts/${row.id}`}
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
