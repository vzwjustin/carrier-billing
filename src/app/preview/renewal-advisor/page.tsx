/**
 * /preview/renewal-advisor — fixture view of the renewal advisor.
 */
import Link from 'next/link';

import { formatCents } from '@/lib/utils';

export const dynamic = 'force-static';

interface ExpiringContract {
  id: string;
  filename: string;
  carrier: string;
  ban_last4: string | null;
  expires: string;
  days_until: number;
  rate_cents: number | null;
}

interface BenchmarkRow {
  carrier: string;
  legacy_plan: string;
  replacement_plan: string;
  line_count: number;
  avg_current_cents: number;
  estimated_monthly_savings_cents: number;
  source_note: string;
}

const EXPIRING: ExpiringContract[] = [
  {
    id: 'c-1',
    filename: 'TMobile-Quote-Apr-2026.pdf',
    carrier: 'T-Mobile',
    ban_last4: null,
    expires: 'May 8, 2026',
    days_until: 13,
    rate_cents: 4800,
  },
  {
    id: 'c-2',
    filename: 'Verizon-Promo-Sheet-Q1-2026.pdf',
    carrier: 'Verizon',
    ban_last4: '7281',
    expires: 'Jan 15, 2027',
    days_until: 235,
    rate_cents: -2000,
  },
];

const BENCHMARKS: BenchmarkRow[] = [
  {
    carrier: 'Verizon',
    legacy_plan: 'More Everything',
    replacement_plan: 'Business Unlimited Plus 2.0',
    line_count: 12,
    avg_current_cents: 7800,
    estimated_monthly_savings_cents: 12000,
    source_note: 'verizon.com/support/no-longer-supported-plans',
  },
  {
    carrier: 'AT&T',
    legacy_plan: 'Mobile Share',
    replacement_plan: 'Business Unlimited Performance',
    line_count: 8,
    avg_current_cents: 6200,
    estimated_monthly_savings_cents: 8000,
    source_note: 'business.att.com/legal/mobile-share-for-business-retired',
  },
  {
    carrier: 'T-Mobile',
    legacy_plan: 'Magenta',
    replacement_plan: 'Business Unlimited Advanced',
    line_count: 5,
    avg_current_cents: 5500,
    estimated_monthly_savings_cents: 3500,
    source_note: 'phonearena.com/news/i-just-ditched-my-grandfathered-t-mobile-magenta-plan',
  },
];

export default function PreviewRenewalAdvisorPage(): React.JSX.Element {
  const totalBenchmarkedSavings = BENCHMARKS.reduce(
    (s, r) => s + r.estimated_monthly_savings_cents,
    0,
  );
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-neutral-900">Renewal Advisor</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Contracts approaching expiration plus benchmarks against carrier
          modern equivalents.
        </p>
      </header>
      <section className="grid gap-4 sm:grid-cols-2">
        <StatTile
          label="Contracts expiring in 90 days"
          value={EXPIRING.filter((c) => c.days_until <= 90).length.toString()}
        />
        <StatTile
          label="Total benchmarked monthly savings"
          value={formatCents(totalBenchmarkedSavings)}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          Expiring contracts
        </h2>
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-2.5">File</th>
                <th className="px-4 py-2.5">Carrier</th>
                <th className="px-4 py-2.5">BAN</th>
                <th className="px-4 py-2.5">Expires</th>
                <th className="px-4 py-2.5">Days until</th>
                <th className="px-4 py-2.5">Rate</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {EXPIRING.map((row) => (
                <tr key={row.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-2.5 text-neutral-900">{row.filename}</td>
                  <td className="px-4 py-2.5 text-neutral-700">{row.carrier}</td>
                  <td className="px-4 py-2.5 font-mono text-neutral-700">
                    {row.ban_last4 ? `…${row.ban_last4}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-neutral-700">{row.expires}</td>
                  <td className="px-4 py-2.5 text-neutral-700">
                    <span
                      className={
                        row.days_until <= 30
                          ? 'rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800'
                          : 'text-neutral-700'
                      }
                    >
                      {row.days_until} days
                    </span>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-900">
                    {row.rate_cents !== null ? formatCents(row.rate_cents) : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <Link
                      href="/preview/contracts"
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
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          Plan benchmark vs carrier modern equivalent
        </h2>
        <p className="text-sm text-neutral-600">
          Estimated total: <strong>{formatCents(totalBenchmarkedSavings)}/mo</strong>{' '}
          across {BENCHMARKS.reduce((s, r) => s + r.line_count, 0)} lines.
        </p>
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-2.5">Carrier</th>
                <th className="px-4 py-2.5">Legacy plan</th>
                <th className="px-4 py-2.5">Suggested replacement</th>
                <th className="px-4 py-2.5">Lines</th>
                <th className="px-4 py-2.5">Avg current</th>
                <th className="px-4 py-2.5">Est. monthly savings</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {BENCHMARKS.map((r) => (
                <tr key={`${r.carrier}-${r.legacy_plan}`} className="hover:bg-neutral-50">
                  <td className="px-4 py-2.5 text-neutral-700">{r.carrier}</td>
                  <td className="px-4 py-2.5 text-neutral-900">{r.legacy_plan}</td>
                  <td className="px-4 py-2.5 text-neutral-900">{r.replacement_plan}</td>
                  <td className="px-4 py-2.5 text-neutral-700">{r.line_count}</td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-700">
                    {formatCents(r.avg_current_cents)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums font-semibold text-green-700">
                    {formatCents(r.estimated_monthly_savings_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatTile({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">
        {value}
      </p>
    </div>
  );
}
