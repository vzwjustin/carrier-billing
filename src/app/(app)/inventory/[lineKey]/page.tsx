/**
 * /inventory/[lineKey] — drill-down for one rolled-up inventory line.
 *
 * Server component. RLS-scoped via the SSR Supabase client.
 *
 * The lineKey is the URL-encoded `{account_last4}/{mdn_last4}` rollup key.
 * We re-fetch the user's completed audits + matching bill_lines and project
 * just the rows that belong to this line. Plan-base history is shown as a
 * small chronological table (no chart library by design).
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  lineHistory,
  parseLineKey,
  type InventoryHistoryEntry,
  type InventoryLineInput,
  type LineStatus,
} from '@/lib/inventory/aggregate';
import { createClient } from '@/lib/supabase/server';
import { formatIsoDateDisplay } from '@/lib/dates';
import { cn, formatCents } from '@/lib/utils';

export const metadata = {
  title: 'Inventory line — CarrierAudit',
};

export const dynamic = 'force-dynamic';

const CARRIER_LABELS: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  unknown: 'Unknown',
};

interface RawLineRow {
  audit_id: string;
  mdn_masked: string | null;
  device_description: string | null;
  plan_name: string | null;
  plan_base_cents: number | null;
  is_suspended: boolean | null;
  account_id: string;
}

interface RawAccountRow {
  id: string;
  account_number_masked: string | null;
}

interface RawAuditRow {
  id: string;
  carrier: string | null;
  billing_period_end: string | null;
  completed_at: string | null;
}

function StatusBadge({ status }: { status: LineStatus }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        status === 'active' ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-700',
      )}
    >
      {status === 'active' ? 'Active' : 'Suspended'}
    </span>
  );
}

export default async function InventoryLinePage({
  params,
}: {
  params: Promise<{ lineKey: string }>;
}): Promise<React.JSX.Element> {
  const resolved = await params;
  const decoded = decodeURIComponent(resolved.lineKey);
  const parsed = parseLineKey(decoded);
  if (!parsed) notFound();

  const supabase = await createClient();
  const { data: auditsData, error: auditsError } = await supabase
    .from('audits')
    .select('id,carrier,billing_period_end,completed_at')
    .eq('status', 'completed')
    .returns<RawAuditRow[]>();

  if (auditsError) {
    throw new Error('Failed to load inventory line.');
  }
  const audits = auditsData ?? [];
  if (audits.length === 0) notFound();

  const auditIds = audits.map((a) => a.id);
  const auditMeta = new Map<string, RawAuditRow>();
  for (const a of audits) auditMeta.set(a.id, a);

  const [linesRes, accountsRes] = await Promise.all([
    supabase
      .from('bill_lines')
      .select(
        'audit_id,mdn_masked,device_description,plan_name,plan_base_cents,is_suspended,account_id',
      )
      .in('audit_id', auditIds)
      .eq('mdn_masked', parsed.mdnLast4)
      .returns<RawLineRow[]>(),
    supabase
      .from('bill_accounts')
      .select('id,account_number_masked')
      .in('audit_id', auditIds)
      .eq('account_number_masked', parsed.accountLast4)
      .returns<RawAccountRow[]>(),
  ]);

  if (linesRes.error || accountsRes.error) {
    throw new Error('Failed to load inventory line.');
  }

  const accountIds = new Set<string>();
  for (const a of accountsRes.data ?? []) accountIds.add(a.id);

  const matching: InventoryLineInput[] = (linesRes.data ?? [])
    .filter((line) => accountIds.has(line.account_id))
    .map((line) => {
      const audit = auditMeta.get(line.audit_id);
      return {
        audit_id: line.audit_id,
        account_number_masked: parsed.accountLast4,
        mdn_masked: line.mdn_masked,
        device_description: line.device_description,
        plan_name: line.plan_name,
        plan_base_cents: line.plan_base_cents,
        is_suspended: line.is_suspended,
        carrier: audit?.carrier ?? null,
        billing_period_end: audit?.billing_period_end ?? null,
        completed_at: audit?.completed_at ?? null,
      };
    });

  if (matching.length === 0) notFound();

  const history = lineHistory(matching);
  const headEntry: InventoryHistoryEntry | undefined = history[0];
  if (!headEntry) notFound();

  // Sparkline-like spread for the plan-base over time (min/max/delta).
  // ⚡ Bolt: Removed Array.map/filter chain and Math.min/Math.max spread overhead.
  let minBase: number | null = null;
  let maxBase: number | null = null;
  let count = 0;
  for (const h of history) {
    if (typeof h.planBaseCents === 'number') {
      if (minBase === null || h.planBaseCents < minBase) minBase = h.planBaseCents;
      if (maxBase === null || h.planBaseCents > maxBase) maxBase = h.planBaseCents;
      count++;
    }
  }
  const deltaCents = count >= 2 && minBase !== null && maxBase !== null ? maxBase - minBase : null;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/inventory" className="text-xs text-neutral-500 hover:text-neutral-900">
          ← All inventory
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          Line *{parsed.mdnLast4}
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Account *{parsed.accountLast4} ·{' '}
          {headEntry.carrier
            ? (CARRIER_LABELS[headEntry.carrier] ?? headEntry.carrier)
            : 'Unknown carrier'}
        </p>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile eyebrow="Latest device" value={headEntry.device ?? '—'} />
        <SummaryTile eyebrow="Latest plan" value={headEntry.planName ?? '—'} />
        <SummaryTile
          eyebrow="Latest plan base"
          value={headEntry.planBaseCents !== null ? formatCents(headEntry.planBaseCents) : '—'}
        />
        <SummaryTile
          eyebrow="Appears on"
          value={`${history.length} audit${history.length === 1 ? '' : 's'}`}
        />
      </section>

      {deltaCents !== null && minBase !== null && maxBase !== null && deltaCents > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Plan base ranged from <span className="font-medium">{formatCents(minBase)}</span> to{' '}
          <span className="font-medium">{formatCents(maxBase)}</span> across the audits below — a
          swing of <span className="font-medium">{formatCents(deltaCents)}</span>.
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-medium tracking-wide text-neutral-500 uppercase">
            <tr>
              <th className="px-4 py-3">Billing period end</th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Plan base</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Audit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {history.map((h) => (
              <tr key={h.auditId} className="hover:bg-neutral-50">
                <td className="px-4 py-3 text-neutral-700">
                  {formatIsoDateDisplay(h.billingPeriodEnd)}
                </td>
                <td className="px-4 py-3 text-neutral-900">
                  <span className="block max-w-xs truncate">{h.device ?? '—'}</span>
                </td>
                <td className="px-4 py-3 text-neutral-700">
                  <span className="block max-w-xs truncate">{h.planName ?? '—'}</span>
                </td>
                <td className="px-4 py-3 text-neutral-900">
                  {h.planBaseCents !== null ? formatCents(h.planBaseCents) : '—'}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={h.status} />
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/audits/${h.auditId}`}
                    className="text-sm font-medium text-neutral-900 hover:underline"
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryTile({ eyebrow, value }: { eyebrow: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">{eyebrow}</p>
      <p className="mt-2 truncate text-lg font-semibold tracking-tight text-neutral-900">{value}</p>
    </div>
  );
}
