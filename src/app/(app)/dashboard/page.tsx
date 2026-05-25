import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { cn, formatCents } from '@/lib/utils';

export const metadata = {
  title: 'Dashboard — CarrierAudit',
};

export const dynamic = 'force-dynamic';

interface DashboardAuditRow {
  id: string;
  created_at: string;
  original_filename: string;
  carrier: string | null;
  status: string;
  estimated_annual_savings_cents: number | null;
}

interface CompletedAggregateRow {
  estimated_annual_savings_cents: number | null;
  high_severity_count: number | null;
}

interface LatestAutopsyRow {
  id: string;
  current_audit_id: string;
  previous_audit_id: string;
  net_change_cents: number;
  percent_change_bps: number | null;
  disputable_cents: number;
  unexplained_cents: number;
  created_at: string;
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

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const supabase = await createClient();

  const [{ count }, latestRes, completedRes, latestAutopsyRes] = await Promise.all([
    supabase.from('audits').select('id', { head: true, count: 'exact' }),
    supabase
      .from('audits')
      .select(
        'id,created_at,original_filename,carrier,status,estimated_annual_savings_cents',
      )
      .order('created_at', { ascending: false })
      .limit(5)
      .returns<DashboardAuditRow[]>(),
    supabase
      .from('audits')
      .select('estimated_annual_savings_cents,high_severity_count')
      .eq('status', 'completed')
      .returns<CompletedAggregateRow[]>(),
    // Most recent Bill Increase Autopsy across all of the user's audits.
    // RLS scopes to the owning user; null if no autopsy has been run yet.
    supabase
      .from('bill_comparisons')
      .select(
        'id,current_audit_id,previous_audit_id,net_change_cents,percent_change_bps,disputable_cents,unexplained_cents,created_at',
      )
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<LatestAutopsyRow>(),
  ]);

  const latest = latestRes.data ?? [];
  const totalAudits = count ?? latest.length;
  const completed = completedRes.data ?? [];
  const lifetimeSavingsCents = completed.reduce(
    (acc, row) => acc + (row.estimated_annual_savings_cents ?? 0),
    0,
  );
  const totalHighSeverity = completed.reduce(
    (acc, row) => acc + (row.high_severity_count ?? 0),
    0,
  );
  const latestAutopsy = latestAutopsyRes.data ?? null;

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
            <p className="mt-3 text-xs text-neutral-500">
              {totalAudits} audit{totalAudits === 1 ? '' : 's'} so far
            </p>
          </div>
          <Link href="/audits/new">
            <Button size="lg">Run an audit</Button>
          </Link>
        </div>
      </section>

      {totalAudits > 0 ? (
        <section
          aria-label="Audit summary"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <StatTile
            eyebrow="Audits run"
            value={totalAudits.toLocaleString('en-US')}
            helper={
              totalAudits === 1
                ? 'Just getting started.'
                : 'Across every bill you’ve uploaded.'
            }
          />
          <StatTile
            eyebrow="Lifetime savings identified"
            value={
              lifetimeSavingsCents > 0
                ? formatCents(lifetimeSavingsCents)
                : '—'
            }
            helper="Sum of estimated annual savings on completed audits."
          />
          <StatTile
            eyebrow="High-severity findings"
            value={totalHighSeverity.toLocaleString('en-US')}
            helper={
              totalHighSeverity === 0
                ? 'No urgent issues right now.'
                : 'Worth showing your carrier rep.'
            }
          />
        </section>
      ) : null}

      {latestAutopsy ? <AutopsyCard autopsy={latestAutopsy} /> : null}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium text-neutral-900">Your audits</h2>
          {latest.length > 0 ? (
            <Link
              href="/audits"
              className="text-sm font-medium text-neutral-700 hover:text-neutral-900"
            >
              View all
            </Link>
          ) : null}
        </div>

        {latest.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
            <p className="text-sm text-neutral-700">
              You haven&apos;t run any audits yet.
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              Upload your first bill to see findings here.
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
                {latest.map((row) => (
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
                      {row.carrier
                        ? CARRIER_LABELS[row.carrier] ?? row.carrier
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          STATUS_STYLES[row.status] ??
                            'bg-neutral-100 text-neutral-700',
                        )}
                      >
                        {STATUS_LABELS[row.status] ?? row.status}
                      </span>
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
      </section>
    </div>
  );
}

function StatTile({
  eyebrow,
  value,
  helper,
}: {
  eyebrow: string;
  value: string;
  helper: string;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {eyebrow}
      </p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-neutral-900">
        {value}
      </p>
      <p className="mt-2 text-xs text-neutral-500">{helper}</p>
    </div>
  );
}

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

function AutopsyCard({
  autopsy,
}: {
  autopsy: LatestAutopsyRow;
}): React.JSX.Element {
  const direction =
    autopsy.net_change_cents === 0
      ? 'unchanged'
      : autopsy.net_change_cents > 0
        ? 'up'
        : 'down';
  return (
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
          {autopsy.disputable_cents > 0 ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-900">
                Potentially disputable
              </p>
              <p className="mt-0.5 text-base font-semibold tabular-nums text-amber-900">
                {formatCents(autopsy.disputable_cents)}
              </p>
            </div>
          ) : null}
          {autopsy.unexplained_cents > 0 ? (
            <div className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                Unexplained
              </p>
              <p className="mt-0.5 text-base font-semibold tabular-nums text-neutral-700">
                {formatCents(autopsy.unexplained_cents)}
              </p>
            </div>
          ) : null}
          <Link
            href={`/audits/${autopsy.current_audit_id}/autopsy`}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
          >
            View autopsy →
          </Link>
        </div>
      </div>
    </section>
  );
}
