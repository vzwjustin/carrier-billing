import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OnboardingChecklist } from '@/components/dashboard/onboarding-checklist';
import { FindingsOverTimeChart } from '@/components/dashboard/findings-over-time-chart';
import { SpendByCarrierChart } from '@/components/dashboard/spend-by-carrier-chart';
import { Button } from '@/components/ui/button';
import {
  aggregateCostCenters,
  type CostCenterLineInput,
  type CostCenterRollupRow,
} from '@/lib/cost-centers/aggregate';
import { DEFAULT_WINDOW as FINDINGS_WINDOW } from '@/lib/dashboard/findings-over-time';
import {
  findExpiringContracts,
  type ContractRow as RenewalContractRow,
} from '@/lib/renewals/expiring-contracts';
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
  id: string;
  created_at: string;
  carrier: string | null;
  total_charges_cents: number | null;
  estimated_annual_savings_cents: number | null;
  high_severity_count: number | null;
}

interface FindingSeverityRow {
  audit_id: string;
  severity: string;
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

interface CompletedAuditIdRow {
  id: string;
  created_at: string;
}

interface CostCenterLineRow {
  cost_center: string | null;
  plan_base_cents: number | null;
}

interface DashboardContractRow {
  id: string;
  original_filename: string;
  carrier: string | null;
  ban_last4: string | null;
  expiration_date: string | null;
}

const RENEWAL_WINDOW_DAYS = 90;

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

function hasQueryError(error: { message?: string } | null | undefined): boolean {
  return error !== null && error !== undefined;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const supabase = await createClient();
  // `(app)/layout.tsx` already redirects unauthenticated users to /login, but
  // we re-fetch here to get a typed `user.id` for the OnboardingChecklist
  // join. If the layout's session expired between requests, redirect again.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  const [countRes, latestRes, completedRes, latestAutopsyRes, completedIdsRes, contractsRes] =
    await Promise.all([
      supabase.from('audits').select('id', { head: true, count: 'exact' }),
      supabase
        .from('audits')
        .select('id,created_at,original_filename,carrier,status,estimated_annual_savings_cents')
        .order('created_at', { ascending: false })
        .limit(5)
        .returns<DashboardAuditRow[]>(),
      supabase
        .from('audits')
        .select(
          'id,created_at,carrier,total_charges_cents,estimated_annual_savings_cents,high_severity_count',
        )
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
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
      // Completed audit IDs, newest first. Used to (a) fetch cost-center lines
      // across all completed audits and (b) pick the most-recent audit ID for
      // the "Export CSV" link on the cost-center tile.
      supabase
        .from('audits')
        .select('id,created_at')
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .returns<CompletedAuditIdRow[]>(),
      // Contracts with a non-null expiration_date — we filter the window in
      // memory via findExpiringContracts so the dashboard tile and the
      // /renewal-advisor page share one source of truth.
      supabase
        .from('contracts')
        .select('id,original_filename,carrier,ban_last4,expiration_date')
        .not('expiration_date', 'is', null)
        .returns<DashboardContractRow[]>(),
    ]);

  const primaryQueryFailed =
    hasQueryError(countRes.error) ||
    hasQueryError(latestRes.error) ||
    hasQueryError(completedRes.error);

  if (primaryQueryFailed) {
    return (
      <div className="space-y-6">
        <section className="rounded-lg border border-red-200 bg-red-50 p-6">
          <h1 className="text-2xl font-semibold tracking-tight text-red-950">
            Dashboard unavailable
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-red-800">
            We couldn&apos;t load your dashboard metrics. Please refresh the page, or open your
            audits list while we retry the dashboard data.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/dashboard">
              <Button variant="outline">Refresh dashboard</Button>
            </Link>
            <Link href="/audits">
              <Button>View audits</Button>
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const latest = latestRes.data ?? [];
  const totalAudits = countRes.count ?? latest.length;
  const completed = completedRes.data ?? [];

  // ⚡ Bolt: Calculate aggregated values and chart inputs in a single pass over `completed`.
  // This avoids multiple `.reduce()` and `.map()` iterations and intermediate arrays.
  let lifetimeSavingsCents = 0;
  let totalHighSeverity = 0;
  const carrierSpendInput: { carrier: string | null; total_charges_cents: number | null }[] = [];
  for (let i = 0; i < completed.length; i++) {
    const row = completed[i];
    if (row) {
      lifetimeSavingsCents += row.estimated_annual_savings_cents ?? 0;
      totalHighSeverity += row.high_severity_count ?? 0;
      carrierSpendInput.push({
        carrier: row.carrier,
        total_charges_cents: row.total_charges_cents,
      });
    }
  }

  const latestAutopsyUnavailable = hasQueryError(latestAutopsyRes.error);
  const latestAutopsy = latestAutopsyUnavailable ? null : (latestAutopsyRes.data ?? null);

  // Cost-center roll-up: fetch all bill_lines across the user's completed
  // audits (RLS-scoped via the audits join) and aggregate in memory. The
  // tile is hidden entirely if no lines carry a cost_center value, so we
  // skip the second query when there are no completed audits.
  const completedIdsUnavailable = hasQueryError(completedIdsRes.error);
  const completedAuditIds = completedIdsUnavailable
    ? []
    : (completedIdsRes.data ?? []).map((row) => row.id);
  let costCenterRollup: CostCenterRollupRow[] = [];
  let hasAnyCostCenter = false;
  let costCenterUnavailable = completedIdsUnavailable;
  if (!costCenterUnavailable && completedAuditIds.length > 0) {
    const linesRes = await supabase
      .from('bill_lines')
      .select('cost_center,plan_base_cents')
      .in('audit_id', completedAuditIds)
      .returns<CostCenterLineRow[]>();
    costCenterUnavailable = hasQueryError(linesRes.error);
    if (!costCenterUnavailable) {
      const lineRows = linesRes.data ?? [];
      hasAnyCostCenter = lineRows.some(
        (row) => row.cost_center !== null && row.cost_center.trim() !== '',
      );
      if (hasAnyCostCenter) {
        costCenterRollup = aggregateCostCenters(lineRows as CostCenterLineInput[]);
      }
    }
  }
  const mostRecentCompletedAuditId = completedAuditIds[0] ?? null;

  // Spend-by-carrier chart input is now derived in the single-pass loop above.

  // Findings-over-time chart input. The completed audits are already ordered
  // newest-first; we slice to the chart window and look up findings only for
  // those audit IDs so we don't drag back severity rows for older audits.
  const findingsWindowAudits = completed.slice(0, FINDINGS_WINDOW).map((row) => ({
    id: row.id,
    created_at: row.created_at,
  }));
  let findingsSeverityRows: FindingSeverityRow[] = [];
  let findingsUnavailable = false;
  if (findingsWindowAudits.length >= 2) {
    const findingsRes = await supabase
      .from('findings')
      .select('audit_id,severity')
      .in(
        'audit_id',
        findingsWindowAudits.map((a) => a.id),
      )
      .returns<FindingSeverityRow[]>();
    findingsUnavailable = hasQueryError(findingsRes.error);
    findingsSeverityRows = findingsUnavailable ? [] : (findingsRes.data ?? []);
  }

  // Upcoming renewals: contracts expiring in the next RENEWAL_WINDOW_DAYS.
  // The tile is hidden when zero so we don't add visual noise.
  const renewalsUnavailable = hasQueryError(contractsRes.error);
  const expiringRenewalRows: RenewalContractRow[] = (
    renewalsUnavailable ? [] : (contractsRes.data ?? [])
  ).map((row) => ({
    id: row.id,
    original_filename: row.original_filename,
    carrier: row.carrier,
    ban_last4: row.ban_last4,
    expiration_date: row.expiration_date,
    contracted_monthly_rate_cents: null,
  }));
  const expiringRenewalCount = findExpiringContracts(
    expiringRenewalRows,
    new Date(),
    RENEWAL_WINDOW_DAYS,
  ).length;

  return (
    <div className="space-y-8">
      {totalAudits === 0 ? (
        // Brand-new user — replace the generic welcome with the onboarding
        // checklist. The checklist hides itself once every detectable step
        // is complete, so power users won't see it.
        <OnboardingChecklist userId={user.id} />
      ) : (
        <>
          <section className="rounded-lg border border-neutral-200 bg-white p-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
                  Welcome to CarrierAudit
                </h1>
                <p className="mt-1 text-sm text-neutral-500">
                  Upload a business wireless bill and we&apos;ll find your wasted spend.
                </p>
                <p className="mt-3 text-xs text-neutral-500">
                  {totalAudits} audit{totalAudits === 1 ? '' : 's'} so far
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <a
                  href="/api/reports/executive.pdf?n=3"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
                >
                  Download executive summary
                </a>
                <Link href="/audits/new">
                  <Button size="lg">Run an audit</Button>
                </Link>
              </div>
            </div>
          </section>
          {/* Still surface the checklist for partially-onboarded users
              (e.g. one audit but no cost-center tags or contract uploaded).
              It returns null once everything detectable is done. */}
          <OnboardingChecklist userId={user.id} />
        </>
      )}

      {totalAudits > 0 ? (
        <section aria-label="Audit summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatTile
            eyebrow="Audits run"
            value={totalAudits.toLocaleString('en-US')}
            helper={
              totalAudits === 1 ? 'Just getting started.' : 'Across every bill you’ve uploaded.'
            }
          />
          <StatTile
            eyebrow="Lifetime savings identified"
            value={lifetimeSavingsCents > 0 ? formatCents(lifetimeSavingsCents) : '—'}
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

      {/* Mini visualizations sit between the stat tiles and the autopsy card
          so the most important info (lifetime savings, high-sev count) stays
          at the top of the page. Each chart self-hides when its threshold
          isn't met, so this region collapses gracefully for new accounts. */}
      {totalAudits > 0 ? <SpendByCarrierChart audits={carrierSpendInput} /> : null}
      {findingsUnavailable ? (
        <SectionUnavailable
          title="Findings trend unavailable"
          message="We couldn't load finding history for the trend chart. Other dashboard data is still available."
        />
      ) : (
        <FindingsOverTimeChart audits={findingsWindowAudits} findings={findingsSeverityRows} />
      )}

      {expiringRenewalCount > 0 ? <UpcomingRenewalsTile count={expiringRenewalCount} /> : null}

      {renewalsUnavailable ? (
        <SectionUnavailable
          title="Upcoming renewals unavailable"
          message="We couldn't load contract renewal dates right now."
        />
      ) : null}

      {latestAutopsy ? <AutopsyCard autopsy={latestAutopsy} /> : null}

      {latestAutopsyUnavailable ? (
        <SectionUnavailable
          title="Latest autopsy unavailable"
          message="We couldn't load the latest bill comparison right now."
        />
      ) : null}

      {hasAnyCostCenter && costCenterRollup.length > 0 ? (
        <CostCenterTile rollup={costCenterRollup} exportAuditId={mostRecentCompletedAuditId} />
      ) : null}

      {costCenterUnavailable ? (
        <SectionUnavailable
          title="Cost center spend unavailable"
          message="We couldn't load cost center line data right now."
        />
      ) : null}

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
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-500">
              <svg
                aria-hidden
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z"
                />
              </svg>
            </div>
            <p className="mt-4 text-sm font-medium text-neutral-900">
              You haven&apos;t run any audits yet
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              Upload a Verizon, AT&amp;T, or T-Mobile business wireless bill to see findings here.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <Link href="/audits/new">
                <Button>Upload your first bill</Button>
              </Link>
              <Link href="/share/verizon_business_large_sample_v1">
                <Button variant="outline">See a sample report</Button>
              </Link>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs font-medium tracking-wide text-neutral-500 uppercase">
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
                    <td className="px-4 py-3 text-neutral-700">{formatDate(row.created_at)}</td>
                    <td className="px-4 py-3 text-neutral-900">
                      <span className="block max-w-xs truncate">{row.original_filename}</span>
                    </td>
                    <td className="px-4 py-3 text-neutral-700">
                      {row.carrier ? (CARRIER_LABELS[row.carrier] ?? row.carrier) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          STATUS_STYLES[row.status] ?? 'bg-neutral-100 text-neutral-700',
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

function SectionUnavailable({
  title,
  message,
}: {
  title: string;
  message: string;
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-medium text-amber-950">{title}</p>
      <p className="mt-1 text-sm text-amber-800">{message}</p>
    </section>
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
      <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">{eyebrow}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-neutral-900">{value}</p>
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

function AutopsyCard({ autopsy }: { autopsy: LatestAutopsyRow }): React.JSX.Element {
  const direction =
    autopsy.net_change_cents === 0 ? 'unchanged' : autopsy.net_change_cents > 0 ? 'up' : 'down';
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
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
          <p className="mt-2 text-xs text-neutral-500">Compared with the previous bill period</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {autopsy.disputable_cents > 0 ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold tracking-wider text-amber-900 uppercase">
                Potentially disputable
              </p>
              <p className="mt-0.5 text-base font-semibold text-amber-900 tabular-nums">
                {formatCents(autopsy.disputable_cents)}
              </p>
            </div>
          ) : null}
          {autopsy.unexplained_cents > 0 ? (
            <div className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold tracking-wider text-neutral-600 uppercase">
                Unexplained
              </p>
              <p className="mt-0.5 text-base font-semibold text-neutral-700 tabular-nums">
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

function CostCenterTile({
  rollup,
  exportAuditId,
}: {
  rollup: CostCenterRollupRow[];
  exportAuditId: string | null;
}): React.JSX.Element {
  const totalCents = rollup.reduce((acc, row) => acc + row.monthly_total_cents, 0);
  return (
    <section
      aria-label="Spend by cost center"
      className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Spend by cost center
          </p>
          <p className="mt-1 text-lg font-semibold tracking-tight text-neutral-900">
            {formatCents(totalCents)}
            <span className="ml-2 text-xs font-normal text-neutral-500">
              monthly across completed audits
            </span>
          </p>
        </div>
        {exportAuditId ? (
          <Link
            href={`/api/audits/${exportAuditId}/cost-centers.csv`}
            className="text-sm font-medium text-neutral-700 hover:text-neutral-900"
          >
            Export CSV
          </Link>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-lg border border-neutral-200">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-medium tracking-wide text-neutral-500 uppercase">
            <tr>
              <th className="px-4 py-2">Cost center</th>
              <th className="px-4 py-2 text-right">Lines</th>
              <th className="px-4 py-2 text-right">Monthly</th>
              <th className="px-4 py-2">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {rollup.map((row) => {
              const pct = Math.round(row.share * 100);
              return (
                <tr key={row.cost_center} className="hover:bg-neutral-50">
                  <td className="px-4 py-2 text-neutral-900">{row.cost_center}</td>
                  <td className="px-4 py-2 text-right text-neutral-700 tabular-nums">
                    {row.line_count.toLocaleString('en-US')}
                  </td>
                  <td className="px-4 py-2 text-right text-neutral-900 tabular-nums">
                    {formatCents(row.monthly_total_cents)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div
                        aria-hidden
                        className="h-2 w-24 overflow-hidden rounded-full bg-neutral-100"
                      >
                        <div
                          className="h-full bg-neutral-700"
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                      <span className="text-xs text-neutral-500 tabular-nums">{pct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UpcomingRenewalsTile({ count }: { count: number }): React.JSX.Element {
  return (
    <section
      aria-label="Upcoming renewals"
      className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Upcoming renewals
          </p>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-neutral-900 tabular-nums">
            {count.toLocaleString('en-US')}
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            Contract{count === 1 ? '' : 's'} expiring in the next 90 days.
          </p>
        </div>
        <Link
          href="/renewal-advisor"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
        >
          Open renewal advisor →
        </Link>
      </div>
    </section>
  );
}
