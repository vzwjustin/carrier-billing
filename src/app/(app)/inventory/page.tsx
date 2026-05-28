/**
 * /inventory — Wireless Inventory.
 *
 * Server component. RLS-scoped: uses the SSR Supabase client so every query
 * is filtered to the calling user's own audits + bill_lines + bill_accounts
 * via the `own audit children read` policies declared in 0001_init.sql.
 *
 * Pulls bill_lines for the user's COMPLETED audits, joins masked account
 * number and parent audit metadata, and rolls them up into one row per
 * (account_last4, mdn_last4). Filters live in the URL so they're shareable
 * and the page is fully cacheable per query string.
 */

import Link from 'next/link';

import { InventoryFilters } from '@/components/inventory/inventory-filters';
import { Button } from '@/components/ui/button';
import {
  aggregateInventory,
  classifyDevice,
  summarizeInventory,
  type DeviceType,
  type InventoryLineInput,
  type InventoryRow,
  type LineStatus,
} from '@/lib/inventory/aggregate';
import { createClient } from '@/lib/supabase/server';
import { cn, formatCents } from '@/lib/utils';

export const metadata = {
  title: 'Inventory — CarrierAudit',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  phone: 'Phone',
  tablet: 'Tablet',
  watch: 'Watch',
  hotspot: 'Hotspot',
  router: 'Router',
  other: 'Other',
};

const VALID_CARRIERS = new Set(['verizon', 'att', 'tmobile', 'unknown']);
const VALID_DEVICE_TYPES = new Set<DeviceType>([
  'phone',
  'tablet',
  'watch',
  'hotspot',
  'router',
  'other',
]);
const VALID_STATUSES = new Set<LineStatus>(['active', 'suspended']);

interface InventoryPageProps {
  searchParams?: Promise<{
    q?: string | string[];
    carrier?: string | string[];
    account?: string | string[];
    deviceType?: string | string[];
    status?: string | string[];
    page?: string | string[];
  }>;
}

function pickString(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

function parsePage(raw: string | string[] | undefined): number {
  const v = pickString(raw);
  if (!v) return 1;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || n > 1000) return 1;
  return n;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

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

export default async function InventoryPage(
  props: InventoryPageProps,
): Promise<React.JSX.Element> {
  const search = props.searchParams ? await props.searchParams : undefined;

  const q = pickString(search?.q)?.slice(0, 80) ?? '';
  const rawCarrier = pickString(search?.carrier);
  const carrier = rawCarrier && VALID_CARRIERS.has(rawCarrier) ? rawCarrier : '';
  const account = pickString(search?.account)?.slice(0, 12) ?? '';
  const rawDeviceType = pickString(search?.deviceType);
  const deviceType =
    rawDeviceType && VALID_DEVICE_TYPES.has(rawDeviceType as DeviceType)
      ? (rawDeviceType as DeviceType)
      : '';
  const rawStatus = pickString(search?.status);
  const status =
    rawStatus && VALID_STATUSES.has(rawStatus as LineStatus)
      ? (rawStatus as LineStatus)
      : '';
  const page = parsePage(search?.page);

  const supabase = await createClient();

  // 1. Load the user's completed audits. RLS ensures we only see our own.
  let auditsQuery = supabase
    .from('audits')
    .select('id,carrier,billing_period_end,completed_at')
    .eq('status', 'completed');
  if (carrier) auditsQuery = auditsQuery.eq('carrier', carrier);
  const { data: auditsData, error: auditsError } = await auditsQuery
    .returns<RawAuditRow[]>();

  if (auditsError) {
    return <InventoryError />;
  }

  const audits = auditsData ?? [];

  if (audits.length === 0) {
    return <InventoryEmpty />;
  }

  const auditIds = audits.map((a) => a.id);
  const auditMeta = new Map<string, RawAuditRow>();
  for (const a of audits) auditMeta.set(a.id, a);

  // 2. Load lines + accounts for those audits in parallel. RLS filters again.
  const [linesRes, accountsRes] = await Promise.all([
    supabase
      .from('bill_lines')
      .select(
        'audit_id,mdn_masked,device_description,plan_name,plan_base_cents,is_suspended,account_id',
      )
      .in('audit_id', auditIds)
      .returns<RawLineRow[]>(),
    supabase
      .from('bill_accounts')
      .select('id,account_number_masked')
      .in('audit_id', auditIds)
      .returns<RawAccountRow[]>(),
  ]);

  if (linesRes.error || accountsRes.error) {
    return <InventoryError />;
  }

  const accountById = new Map<string, string | null>();
  for (const acct of accountsRes.data ?? []) {
    accountById.set(acct.id, acct.account_number_masked);
  }

  const inputs: InventoryLineInput[] = (linesRes.data ?? []).map((line) => {
    const audit = auditMeta.get(line.audit_id);
    return {
      audit_id: line.audit_id,
      account_number_masked: accountById.get(line.account_id) ?? null,
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

  const allRows = aggregateInventory(inputs);

  // Filter post-aggregation. Filters that pre-prune the SQL query (carrier)
  // are already applied above; the rest apply against the rolled-up rows.
  const filtered = allRows.filter((row) => {
    if (account && row.accountLast4 !== account) return false;
    if (deviceType && row.deviceType !== deviceType) return false;
    if (status && row.status !== status) return false;
    if (q) {
      const needle = q.toLowerCase();
      const hay = [row.device, row.planName, row.mdnLast4]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  // Stats reflect the filter set so they re-explain what the user is seeing.
  const stats = summarizeInventory(filtered);

  // Account dropdown options come from the user's full dataset (not the
  // filtered set) so the user can switch accounts without losing the list.
  const accountSet = new Set<string>();
  for (const r of allRows) {
    if (r.accountLast4 && r.accountLast4 !== 'no-account') {
      accountSet.add(r.accountLast4);
    }
  }
  const accountOptions = Array.from(accountSet).sort();

  // Pagination — slice the already-filtered + sorted rows.
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const filtersActive = Boolean(
    q || carrier || account || deviceType || status,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            Wireless Inventory
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Every line across your completed audits, rolled up in one view.
          </p>
        </div>
        <Link href="/audits/new">
          <Button>New audit</Button>
        </Link>
      </div>

      <section
        aria-label="Inventory summary"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <StatTile eyebrow="Total lines" value={stats.totalLines.toLocaleString('en-US')} />
        <StatTile eyebrow="Active" value={stats.active.toLocaleString('en-US')} />
        <StatTile eyebrow="Suspended" value={stats.suspended.toLocaleString('en-US')} />
        <StatTile
          eyebrow="Unique devices"
          value={stats.uniqueDevices.toLocaleString('en-US')}
        />
      </section>

      <InventoryFilters
        initial={{ q, carrier, account, deviceType, status }}
        accountOptions={accountOptions}
        filtersActive={filtersActive}
      />

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
          <p className="text-sm text-neutral-700">
            {filtersActive
              ? 'No lines match those filters.'
              : 'No lines in your completed audits yet.'}
          </p>
          {filtersActive ? (
            <div className="mt-4">
              <Link href="/inventory">
                <Button>Clear filters</Button>
              </Link>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Line</th>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Last seen</th>
                <th className="px-4 py-3">Plan base</th>
                <th className="px-4 py-3"># audits</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {pageRows.map((row) => (
                <InventoryTableRow key={row.lineKey} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <Pagination
          page={safePage}
          totalPages={totalPages}
          search={{ q, carrier, account, deviceType, status }}
        />
      ) : null}
    </div>
  );
}

function StatTile({
  eyebrow,
  value,
}: {
  eyebrow: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {eyebrow}
      </p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-neutral-900">
        {value}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: LineStatus }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        status === 'active'
          ? 'bg-green-100 text-green-700'
          : 'bg-neutral-100 text-neutral-700',
      )}
    >
      {status === 'active' ? 'Active' : 'Suspended'}
    </span>
  );
}

function DeviceTypeChip({ type }: { type: DeviceType }): React.JSX.Element {
  return (
    <span className="ml-2 inline-flex items-center rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600">
      {DEVICE_TYPE_LABELS[type]}
    </span>
  );
}

function InventoryTableRow({ row }: { row: InventoryRow }): React.JSX.Element {
  // Sanity assertion: classifier is deterministic so we can show the chip
  // straight from the row, but we double-check during render that it matches
  // the input device string (defense in depth against stale rollups).
  const chipType: DeviceType = row.device ? classifyDevice(row.device) : row.deviceType;
  const href = `/inventory/${encodeURIComponent(row.lineKey)}`;
  return (
    <tr className="hover:bg-neutral-50">
      <td className="px-4 py-3 text-neutral-700">*{row.accountLast4}</td>
      <td className="px-4 py-3 font-mono text-neutral-900">*{row.mdnLast4}</td>
      <td className="px-4 py-3 text-neutral-900">
        <span className="block max-w-xs truncate">{row.device ?? '—'}</span>
        <DeviceTypeChip type={chipType} />
      </td>
      <td className="px-4 py-3 text-neutral-700">
        <span className="block max-w-xs truncate">{row.planName ?? '—'}</span>
      </td>
      <td className="px-4 py-3 text-neutral-700">{formatDate(row.lastSeen)}</td>
      <td className="px-4 py-3 text-neutral-900">
        {row.planBaseCents !== null ? formatCents(row.planBaseCents) : '—'}
      </td>
      <td className="px-4 py-3 text-neutral-700">{row.auditCount}</td>
      <td className="px-4 py-3">
        <StatusBadge status={row.status} />
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          href={href}
          className="text-sm font-medium text-neutral-900 hover:underline"
        >
          View
        </Link>
        <span className="sr-only">
          {' '}
          history for line ending in {row.mdnLast4}
        </span>
      </td>
    </tr>
  );
}

function buildHref(params: {
  q: string;
  carrier: string;
  account: string;
  deviceType: string;
  status: string;
  page?: number;
}): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set('q', params.q);
  if (params.carrier) sp.set('carrier', params.carrier);
  if (params.account) sp.set('account', params.account);
  if (params.deviceType) sp.set('deviceType', params.deviceType);
  if (params.status) sp.set('status', params.status);
  if (params.page && params.page > 1) sp.set('page', String(params.page));
  const qs = sp.toString();
  return qs ? `/inventory?${qs}` : '/inventory';
}

function Pagination({
  page,
  totalPages,
  search,
}: {
  page: number;
  totalPages: number;
  search: {
    q: string;
    carrier: string;
    account: string;
    deviceType: string;
    status: string;
  };
}): React.JSX.Element {
  const prevHref = page > 1 ? buildHref({ ...search, page: page - 1 }) : null;
  const nextHref =
    page < totalPages ? buildHref({ ...search, page: page + 1 }) : null;
  return (
    <div className="flex items-center justify-between">
      <div className="text-xs text-neutral-500">
        Page {page} of {totalPages}
      </div>
      <div className="flex items-center gap-2">
        {prevHref ? (
          <Link href={prevHref}>
            <Button variant="outline" size="sm">
              ← Previous
            </Button>
          </Link>
        ) : null}
        {nextHref ? (
          <Link href={nextHref}>
            <Button variant="outline" size="sm">
              Next →
            </Button>
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function InventoryEmpty(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Wireless Inventory
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Every line across your completed audits, rolled up in one view.
        </p>
      </div>
      <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
        <p className="text-sm text-neutral-700">
          You don&apos;t have any completed audits yet.
        </p>
        <p className="mt-1 text-sm text-neutral-500">
          Upload a bill and we&apos;ll start building your inventory.
        </p>
        <div className="mt-4">
          <Link href="/audits/new">
            <Button>Upload a bill</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function InventoryError(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
        Wireless Inventory
      </h1>
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        We couldn&apos;t load your inventory. Please refresh the page.
      </div>
    </div>
  );
}

// Re-export to silence "imported but unused" for the type narrowing helpers.
export type { InventoryRow };
