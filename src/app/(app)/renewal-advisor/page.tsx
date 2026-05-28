import Link from 'next/link';

import { Banner } from '@/components/ui/banner';
import {
  findExpiringContracts,
  type ContractRow,
  type ExpiringContractRow,
} from '@/lib/renewals/expiring-contracts';
import {
  benchmarkPlans,
  type BenchmarkRow,
  type BillLineRow,
} from '@/lib/renewals/plan-benchmarks';
import { createClient } from '@/lib/supabase/server';
import { formatCents } from '@/lib/utils';

export const metadata = {
  title: 'Renewal advisor — CarrierAudit',
};

export const dynamic = 'force-dynamic';

const RENEWAL_WINDOW_DAYS = 90;

const CARRIER_LABELS: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  uscellular: 'US Cellular',
  spectrum: 'Spectrum',
  xfinity: 'Xfinity',
  cricket: 'Cricket',
  unknown: 'Unknown',
};

/**
 * Joined contracts + contract_terms row as it comes back from the SELECT.
 * `contract_terms` is `null` when no terms have been extracted yet — we
 * surface the contract regardless because the operator may have filled in
 * the expiration_date by hand on the parent row.
 */
interface RawContractRow {
  id: string;
  original_filename: string;
  carrier: string | null;
  ban_last4: string | null;
  expiration_date: string | null;
  contract_terms:
    | { contracted_monthly_rate_cents: number | null }
    | { contracted_monthly_rate_cents: number | null }[]
    | null;
}

interface AuditCarrierRow {
  id: string;
  carrier: string | null;
}

interface BillLineCarrierJoinRow {
  audit_id: string;
  plan_name: string | null;
  plan_base_cents: number | null;
}

function carrierLabel(value: string | null): string {
  if (!value) return '—';
  return CARRIER_LABELS[value] ?? value;
}

/**
 * The PostgREST embed for `contract_terms` may return either an object (when
 * there's at most one related row, which is our case) or an array depending
 * on how the FK is resolved. Normalize to the first entry's
 * `contracted_monthly_rate_cents` value.
 */
function rateFromTerms(
  terms: RawContractRow['contract_terms'],
): number | null {
  if (terms === null) return null;
  if (Array.isArray(terms)) {
    return terms[0]?.contracted_monthly_rate_cents ?? null;
  }
  return terms.contracted_monthly_rate_cents;
}

export default async function RenewalAdvisorPage(): Promise<React.JSX.Element> {
  const supabase = await createClient();

  // Contracts: RLS-scoped to the current user.
  const contractsRes = await supabase
    .from('contracts')
    .select(
      'id,original_filename,carrier,ban_last4,expiration_date,contract_terms(contracted_monthly_rate_cents)',
    )
    .returns<RawContractRow[]>();

  const rawContracts = contractsRes.data ?? [];
  const contractRows: ContractRow[] = rawContracts.map((c) => ({
    id: c.id,
    original_filename: c.original_filename,
    carrier: c.carrier,
    ban_last4: c.ban_last4,
    expiration_date: c.expiration_date,
    contracted_monthly_rate_cents: rateFromTerms(c.contract_terms),
  }));

  const today = new Date();
  const expiring = findExpiringContracts(
    contractRows,
    today,
    RENEWAL_WINDOW_DAYS,
  );

  // Plan benchmark: join bill_lines through the user's audits so RLS scopes
  // correctly. We pull the audit list first (cheap, indexed on user_id) and
  // then fetch bill_lines via .in('audit_id', ids). Carrier comes off the
  // audit, not the line.
  const auditsRes = await supabase
    .from('audits')
    .select('id,carrier')
    .returns<AuditCarrierRow[]>();
  const audits = auditsRes.data ?? [];
  const carrierByAuditId = new Map<string, string | null>(
    audits.map((a) => [a.id, a.carrier]),
  );

  let benchmark: BenchmarkRow[] = [];
  if (audits.length > 0) {
    const linesRes = await supabase
      .from('bill_lines')
      .select('audit_id,plan_name,plan_base_cents')
      .in(
        'audit_id',
        audits.map((a) => a.id),
      )
      .returns<BillLineCarrierJoinRow[]>();
    const lines: BillLineRow[] = (linesRes.data ?? []).map((line) => ({
      carrier: carrierByAuditId.get(line.audit_id) ?? null,
      plan_name: line.plan_name,
      plan_base_cents: line.plan_base_cents,
    }));
    benchmark = benchmarkPlans(lines);
  }

  const totalBenchmarkSavingsCents = benchmark.reduce(
    (acc, row) => acc + row.estimated_monthly_savings_cents,
    0,
  );
  const hasContracts = rawContracts.length > 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Renewal advisor
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Contracts approaching expiration and current plans that have a
          cheaper modern equivalent on the carrier&apos;s lineup.
        </p>
      </div>

      <section
        aria-label="Renewal summary"
        className="grid gap-4 sm:grid-cols-2"
      >
        <StatTile
          eyebrow={`Contracts expiring in ${RENEWAL_WINDOW_DAYS} days`}
          value={expiring.length.toLocaleString('en-US')}
          helper={
            expiring.length === 0
              ? 'No imminent renewals.'
              : 'Sorted soonest first below.'
          }
        />
        <StatTile
          eyebrow="Benchmarked monthly savings"
          value={
            totalBenchmarkSavingsCents > 0
              ? formatCents(totalBenchmarkSavingsCents)
              : '—'
          }
          helper={
            totalBenchmarkSavingsCents > 0
              ? 'Estimated by moving legacy plans to modern equivalents.'
              : 'No legacy plans matched.'
          }
        />
      </section>

      <section aria-label="Expiring contracts">
        <h2 className="mb-3 text-lg font-medium text-neutral-900">
          Expiring contracts
        </h2>
        {!hasContracts ? (
          <Banner
            variant="info"
            title="No contracts uploaded yet"
            description="Upload a carrier contract or quote to start tracking renewal dates here."
            action={{ label: 'Upload contract', href: '/contracts/new' }}
          />
        ) : expiring.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
            <p className="text-sm text-neutral-700">
              No contracts expire in the next {RENEWAL_WINDOW_DAYS} days.
            </p>
          </div>
        ) : (
          <ExpiringContractsTable rows={expiring} />
        )}
      </section>

      <section aria-label="Plan benchmark">
        <h2 className="mb-3 text-lg font-medium text-neutral-900">
          Plan benchmark
        </h2>
        {benchmark.length === 0 ? (
          <Banner
            variant="success"
            title="No legacy plans detected"
            description="Every plan we found on your bills already maps to a current carrier tier — nothing to migrate."
          />
        ) : (
          <BenchmarkTable rows={benchmark} />
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

function ExpiringContractsTable({
  rows,
}: {
  rows: ReadonlyArray<ExpiringContractRow>;
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-4 py-3">File</th>
            <th className="px-4 py-3">Carrier</th>
            <th className="px-4 py-3">BAN (last 4)</th>
            <th className="px-4 py-3 text-right">Days until expiration</th>
            <th className="px-4 py-3 text-right">Contracted monthly</th>
            <th className="px-4 py-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200">
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-neutral-50">
              <td className="px-4 py-3 text-neutral-900">
                <span className="block max-w-xs truncate">
                  {row.original_filename}
                </span>
              </td>
              <td className="px-4 py-3 text-neutral-700">
                {carrierLabel(row.carrier)}
              </td>
              <td className="px-4 py-3 font-mono text-neutral-700">
                {row.ban_last4 ? `…${row.ban_last4}` : '—'}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-neutral-900">
                {row.days_until_expiration === 0
                  ? 'Today'
                  : `${row.days_until_expiration}d`}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-neutral-900">
                {row.contracted_monthly_rate_cents !== null
                  ? formatCents(row.contracted_monthly_rate_cents)
                  : '—'}
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
  );
}

function BenchmarkTable({
  rows,
}: {
  rows: ReadonlyArray<BenchmarkRow>;
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-4 py-3">Carrier</th>
            <th className="px-4 py-3">Legacy plan</th>
            <th className="px-4 py-3">Suggested replacement</th>
            <th className="px-4 py-3 text-right">Lines</th>
            <th className="px-4 py-3 text-right">Current avg</th>
            <th className="px-4 py-3 text-right">Est. monthly savings</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200">
          {rows.map((row) => (
            <tr
              key={`${row.carrier}::${row.legacy_plan_name}`}
              className="hover:bg-neutral-50"
            >
              <td className="px-4 py-3 text-neutral-700">
                {carrierLabel(row.carrier)}
              </td>
              <td className="px-4 py-3 text-neutral-900">
                <span className="font-mono text-xs">
                  {row.legacy_plan_name}
                </span>
                <span className="ml-2 block text-xs text-neutral-500">
                  {row.source_note}
                </span>
              </td>
              <td className="px-4 py-3 text-neutral-900">
                {row.replacement_plan}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-neutral-700">
                {row.line_count.toLocaleString('en-US')}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-neutral-700">
                {row.current_avg_monthly_cents > 0
                  ? formatCents(row.current_avg_monthly_cents)
                  : '—'}
              </td>
              <td className="px-4 py-3 text-right tabular-nums font-medium text-emerald-700">
                {formatCents(row.estimated_monthly_savings_cents)}
                <span className="ml-1 text-xs font-normal text-neutral-500">
                  /mo
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
