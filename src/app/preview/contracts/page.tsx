/**
 * /preview/contracts — fixture view of the contracts library.
 */
import Link from 'next/link';

import { formatCents } from '@/lib/utils';

export const dynamic = 'force-static';

interface ContractFixtureRow {
  id: string;
  filename: string;
  carrier: string;
  ban_last4: string | null;
  effective_date: string;
  expiration_date: string;
  status: 'parsed' | 'extracting' | 'pending' | 'failed';
  plan_name: string | null;
  contracted_monthly_rate_cents: number | null;
}

const ROWS: ContractFixtureRow[] = [
  {
    id: 'cab-1',
    filename: 'Verizon-Business-Master-Agreement-2026.pdf',
    carrier: 'Verizon',
    ban_last4: '7281',
    effective_date: 'Jan 1, 2026',
    expiration_date: 'Dec 31, 2028',
    status: 'parsed',
    plan_name: 'Business Unlimited Plus 2.0',
    contracted_monthly_rate_cents: 5500,
  },
  {
    id: 'cab-2',
    filename: 'Verizon-Promo-Sheet-Q1-2026.pdf',
    carrier: 'Verizon',
    ban_last4: '7281',
    effective_date: 'Jan 15, 2026',
    expiration_date: 'Jan 15, 2027',
    status: 'parsed',
    plan_name: 'BYOD Loyalty Bonus',
    contracted_monthly_rate_cents: -2000,
  },
  {
    id: 'cab-3',
    filename: 'ATT-Fleet-Order-Form-2026.pdf',
    carrier: 'AT&T',
    ban_last4: '4419',
    effective_date: 'Feb 1, 2026',
    expiration_date: 'Feb 1, 2029',
    status: 'parsed',
    plan_name: 'Business Unlimited Performance',
    contracted_monthly_rate_cents: 5200,
  },
  {
    id: 'cab-4',
    filename: 'TMobile-Quote-Apr-2026.pdf',
    carrier: 'T-Mobile',
    ban_last4: null,
    effective_date: 'Apr 8, 2026',
    expiration_date: 'May 8, 2026',
    status: 'extracting',
    plan_name: null,
    contracted_monthly_rate_cents: null,
  },
];

const STATUS_LABEL: Record<ContractFixtureRow['status'], string> = {
  parsed: 'Parsed',
  extracting: 'Extracting',
  pending: 'Pending',
  failed: 'Failed',
};

const STATUS_STYLES: Record<ContractFixtureRow['status'], string> = {
  parsed: 'bg-emerald-100 text-emerald-800',
  extracting: 'bg-blue-100 text-blue-800',
  pending: 'bg-neutral-100 text-neutral-700',
  failed: 'bg-red-100 text-red-700',
};

export default function PreviewContractsPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Contracts</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Upload carrier contracts, promo sheets, and order forms. Extracted
            terms drive the <code>contract_rate_mismatch</code> rule.
          </p>
        </div>
        <Link
          href="/preview"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Upload contract
        </Link>
      </div>
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2.5">File</th>
              <th className="px-4 py-2.5">Carrier</th>
              <th className="px-4 py-2.5">BAN</th>
              <th className="px-4 py-2.5">Effective</th>
              <th className="px-4 py-2.5">Expires</th>
              <th className="px-4 py-2.5">Plan</th>
              <th className="px-4 py-2.5">Rate</th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {ROWS.map((r) => (
              <tr key={r.id} className="hover:bg-neutral-50">
                <td className="px-4 py-2.5 text-neutral-900">{r.filename}</td>
                <td className="px-4 py-2.5 text-neutral-700">{r.carrier}</td>
                <td className="px-4 py-2.5 font-mono text-neutral-700">
                  {r.ban_last4 ? `…${r.ban_last4}` : '—'}
                </td>
                <td className="px-4 py-2.5 text-neutral-700">{r.effective_date}</td>
                <td className="px-4 py-2.5 text-neutral-700">{r.expiration_date}</td>
                <td className="px-4 py-2.5 text-neutral-700">{r.plan_name ?? '—'}</td>
                <td className="px-4 py-2.5 tabular-nums text-neutral-900">
                  {r.contracted_monthly_rate_cents !== null
                    ? formatCents(r.contracted_monthly_rate_cents)
                    : '—'}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[r.status]}`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
