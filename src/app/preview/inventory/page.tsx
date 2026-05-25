/**
 * /preview/inventory — fixture-data view of the inventory page.
 *
 * Renders the production InventoryFilters component on top of a small
 * static table built from the same row shape that the real page produces.
 * Not linked from app nav.
 */
import Link from 'next/link';

import { InventoryFilters } from '@/components/inventory/inventory-filters';
import { formatCents } from '@/lib/utils';

export const dynamic = 'force-static';

interface InventoryFixtureRow {
  account_last4: string | null;
  mdn_last4: string | null;
  device: string | null;
  plan_name: string | null;
  device_type: 'phone' | 'tablet' | 'watch' | 'hotspot' | 'router' | 'other';
  audits_count: number;
  last_seen: string;
  plan_base_cents: number;
  is_suspended: boolean;
  line_key: string;
}

const FIXTURE_ROWS: InventoryFixtureRow[] = [
  { account_last4: '7281', mdn_last4: '2100', device: 'iPhone 16 Pro', plan_name: 'Business Unlimited Plus 2.0', device_type: 'phone', audits_count: 3, last_seen: 'Apr 30, 2026', plan_base_cents: 6500, is_suspended: false, line_key: '7281/2100' },
  { account_last4: '7281', mdn_last4: '2101', device: 'iPhone 15', plan_name: 'Business Unlimited Pro 2.0', device_type: 'phone', audits_count: 3, last_seen: 'Apr 30, 2026', plan_base_cents: 5500, is_suspended: false, line_key: '7281/2101' },
  { account_last4: '7281', mdn_last4: '2102', device: 'Samsung Galaxy S25', plan_name: 'Business Unlimited Plus 2.0', device_type: 'phone', audits_count: 3, last_seen: 'Apr 30, 2026', plan_base_cents: 6500, is_suspended: false, line_key: '7281/2102' },
  { account_last4: '7281', mdn_last4: '4012', device: 'iPad Pro', plan_name: 'Business Unlimited Tablet', device_type: 'tablet', audits_count: 2, last_seen: 'Apr 30, 2026', plan_base_cents: 2000, is_suspended: false, line_key: '7281/4012' },
  { account_last4: '7281', mdn_last4: '4188', device: 'iPad Air', plan_name: 'Business Unlimited Tablet', device_type: 'tablet', audits_count: 2, last_seen: 'Apr 30, 2026', plan_base_cents: 2000, is_suspended: false, line_key: '7281/4188' },
  { account_last4: '7281', mdn_last4: '5012', device: 'Apple Watch Series 10', plan_name: 'Business Smartwatch Plan', device_type: 'watch', audits_count: 2, last_seen: 'Apr 30, 2026', plan_base_cents: 1000, is_suspended: false, line_key: '7281/5012' },
  { account_last4: '7281', mdn_last4: '6677', device: 'iPhone 14', plan_name: 'Business Unlimited Plus 2.0', device_type: 'phone', audits_count: 3, last_seen: 'Apr 30, 2026', plan_base_cents: 4500, is_suspended: true, line_key: '7281/6677' },
  { account_last4: '4419', mdn_last4: '5512', device: 'Pixel 8', plan_name: 'Business Unlimited Performance', device_type: 'phone', audits_count: 3, last_seen: 'Apr 30, 2026', plan_base_cents: 5200, is_suspended: false, line_key: '4419/5512' },
  { account_last4: '4419', mdn_last4: '5513', device: 'Verizon Jetpack MiFi 8800L', plan_name: 'Business Hotspot 50GB', device_type: 'hotspot', audits_count: 2, last_seen: 'Apr 30, 2026', plan_base_cents: 4000, is_suspended: false, line_key: '4419/5513' },
  { account_last4: '9930', mdn_last4: '7720', device: 'Cradlepoint IBR900', plan_name: 'Fleet Connect Pro', device_type: 'router', audits_count: 2, last_seen: 'Apr 30, 2026', plan_base_cents: 8500, is_suspended: false, line_key: '9930/7720' },
];

const STATS = {
  total: 85,
  active: 84,
  suspended: 1,
  uniqueDevices: 18,
};

export default function PreviewInventoryPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">
          Wireless inventory
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Every line across every completed audit. Drill in to see a line&apos;s
          plan history.
        </p>
      </div>
      <section
        aria-label="Inventory summary"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <StatTile label="Total lines" value={STATS.total.toLocaleString()} />
        <StatTile label="Active" value={STATS.active.toLocaleString()} />
        <StatTile label="Suspended" value={STATS.suspended.toLocaleString()} />
        <StatTile label="Unique devices" value={STATS.uniqueDevices.toLocaleString()} />
      </section>
      <InventoryFilters
        initial={{ q: '', carrier: '', account: '', deviceType: '', status: '' }}
        accountOptions={['7281', '4419', '9930']}
        filtersActive={false}
      />
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2.5">Account</th>
              <th className="px-3 py-2.5">Line</th>
              <th className="px-3 py-2.5">Device</th>
              <th className="px-3 py-2.5">Type</th>
              <th className="px-3 py-2.5">Plan</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5"># audits</th>
              <th className="px-3 py-2.5">Plan base</th>
              <th className="px-3 py-2.5">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {FIXTURE_ROWS.map((row) => (
              <tr key={row.line_key} className="hover:bg-neutral-50">
                <td className="px-3 py-2 font-mono text-neutral-700">
                  …{row.account_last4 ?? '----'}
                </td>
                <td className="px-3 py-2 font-mono text-neutral-700">
                  *{row.mdn_last4 ?? '----'}
                </td>
                <td className="px-3 py-2 text-neutral-900">{row.device ?? '—'}</td>
                <td className="px-3 py-2 text-neutral-700">{row.device_type}</td>
                <td className="px-3 py-2 text-neutral-700">{row.plan_name ?? '—'}</td>
                <td className="px-3 py-2">
                  {row.is_suspended ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      Suspended
                    </span>
                  ) : (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                      Active
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-neutral-700">{row.audits_count}</td>
                <td className="px-3 py-2 tabular-nums text-neutral-900">
                  {formatCents(row.plan_base_cents)}
                </td>
                <td className="px-3 py-2 text-neutral-700">{row.last_seen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-500">
        Showing 10 of 85 fixture lines.{' '}
        <Link href="/preview" className="underline">
          back to preview index
        </Link>
      </p>
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
