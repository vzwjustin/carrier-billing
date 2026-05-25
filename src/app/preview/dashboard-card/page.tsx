import Link from 'next/link';

import { cn, formatCents } from '@/lib/utils';

export const dynamic = 'force-static';

// Mirror of the AutopsyCard in dashboard/page.tsx — kept as a local copy
// so the preview doesn't have to lift the component into a shared module
// before there's a second caller (CLAUDE.md "three call sites" rule).
function signedCents(cents: number): string {
  if (cents === 0) return formatCents(0);
  const sign = cents > 0 ? '+' : '-';
  return `${sign}${formatCents(Math.abs(cents))}`;
}

function percentLabel(bps: number | null): string {
  if (bps === null) return 'new account';
  const pct = (bps / 100).toFixed(1);
  return `${bps >= 0 ? '+' : ''}${pct}%`;
}

const autopsy = {
  id: '11111111-1111-1111-1111-111111111111',
  current_audit_id: '00000000-0000-0000-0000-000000000001',
  previous_audit_id: '00000000-0000-0000-0000-000000000002',
  net_change_cents: 84321,
  percent_change_bps: 701,
  disputable_cents: 27450,
  unexplained_cents: 4221,
  created_at: '2026-05-24T22:14:08.000Z',
};

export default function DashboardCardPreviewPage(): React.JSX.Element {
  const direction =
    autopsy.net_change_cents === 0
      ? 'unchanged'
      : autopsy.net_change_cents > 0
        ? 'up'
        : 'down';
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-neutral-900">
        Dashboard — Bill Increase Autopsy summary card
      </h1>
      <p className="text-sm text-neutral-600">
        Renders on the dashboard above the audits table when the user has at
        least one stored autopsy. Hidden when none exists.
      </p>
      <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Latest Bill Increase Autopsy
            </p>
            <p
              className={cn(
                'mt-1 text-3xl font-semibold tabular-nums',
                direction === 'up' && 'text-red-700',
                direction === 'down' && 'text-green-700',
                direction === 'unchanged' && 'text-neutral-700',
              )}
            >
              {signedCents(autopsy.net_change_cents)}
              <span className="ml-2 text-sm font-medium text-neutral-500">
                ({percentLabel(autopsy.percent_change_bps)})
              </span>
            </p>
            <p className="mt-2 text-xs text-neutral-500">
              Compared with the previous bill period
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-900">
                Potentially disputable
              </p>
              <p className="mt-0.5 text-base font-semibold tabular-nums text-amber-900">
                {formatCents(autopsy.disputable_cents)}
              </p>
            </div>
            <div className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                Unexplained
              </p>
              <p className="mt-0.5 text-base font-semibold tabular-nums text-neutral-700">
                {formatCents(autopsy.unexplained_cents)}
              </p>
            </div>
            <Link
              href={`/audits/${autopsy.current_audit_id}/autopsy`}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
            >
              View autopsy →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
