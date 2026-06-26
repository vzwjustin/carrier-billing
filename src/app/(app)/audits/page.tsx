import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { cn, formatCents } from '@/lib/utils';

export const metadata = {
  title: 'Audits — CarrierAudit',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const VALID_STATUSES = ['pending', 'extracting', 'analyzing', 'completed', 'failed'] as const;
type AuditStatus = (typeof VALID_STATUSES)[number];

interface AuditListRow {
  id: string;
  created_at: string;
  original_filename: string;
  carrier: string | null;
  status: string;
  estimated_annual_savings_cents: number | null;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-neutral-100 text-neutral-700',
  extracting: 'bg-blue-100 text-blue-700',
  analyzing: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued',
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

interface AuditsPageProps {
  searchParams?: Promise<{
    after?: string | string[];
    q?: string | string[];
    status?: string | string[];
  }>;
}

function pickString(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseAfter(raw: string | string[] | undefined): string | null {
  const value = pickString(raw);
  if (!value) return null;
  // Validate as ISO timestamp; reject anything else to avoid query injection.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return value;
}

function parseStatus(raw: string | string[] | undefined): AuditStatus | null {
  const value = pickString(raw);
  if (!value) return null;
  return (VALID_STATUSES as ReadonlyArray<string>).includes(value) ? (value as AuditStatus) : null;
}

function parseQ(raw: string | string[] | undefined): string | null {
  const value = pickString(raw);
  if (!value) return null;
  // Cap length so we don't issue absurd queries.
  return value.slice(0, 80);
}

function buildHref(params: {
  after?: string | null;
  q?: string | null;
  status?: AuditStatus | null;
}): string {
  const sp = new URLSearchParams();
  if (params.after) sp.set('after', params.after);
  if (params.q) sp.set('q', params.q);
  if (params.status) sp.set('status', params.status);
  const query = sp.toString();
  return query ? `/audits?${query}` : '/audits';
}

export default async function AuditsPage(props: AuditsPageProps): Promise<React.JSX.Element> {
  const search = props.searchParams ? await props.searchParams : undefined;
  const after = parseAfter(search?.after);
  const status = parseStatus(search?.status);
  const q = parseQ(search?.q);

  const supabase = await createClient();
  let query = supabase
    .from('audits')
    .select('id,created_at,original_filename,carrier,status,estimated_annual_savings_cents')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (after) {
    query = query.lt('created_at', after);
  }
  if (status) {
    query = query.eq('status', status);
  }
  if (q) {
    // Escape PostgREST `%` and `,` to keep the LIKE pattern safe.
    const escaped = q.replace(/[\\%_,]/g, (m) => `\\${m}`);
    query = query.ilike('original_filename', `%${escaped}%`);
  }

  const { data, error } = await query.returns<AuditListRow[]>();

  const all = data ?? [];
  const hasNextPage = all.length > PAGE_SIZE;
  const rows = hasNextPage ? all.slice(0, PAGE_SIZE) : all;
  const lastRow = rows[rows.length - 1];
  const nextCursor = hasNextPage && lastRow ? lastRow.created_at : null;

  const filtersActive = Boolean(q || status);
  const firstPageHref = buildHref({ q, status });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Your audits</h1>
        <Link href="/audits/new">
          <Button>New audit</Button>
        </Link>
      </div>

      <form
        method="get"
        action="/audits"
        className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-3 sm:flex-row sm:items-center"
      >
        <label className="flex-1 sm:max-w-md">
          <span className="sr-only">Search by filename</span>
          <input
            type="text"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Search by filename…"
            maxLength={80}
            className="block h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 focus-visible:outline-none"
          />
        </label>
        <label className="sm:w-44">
          <span className="sr-only">Filter by status</span>
          <select
            name="status"
            defaultValue={status ?? ''}
            className="block h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            <option value="">All statuses</option>
            {VALID_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s] ?? s}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm">
            Apply
          </Button>
          {filtersActive ? (
            <Link href="/audits">
              <Button type="button" size="sm" variant="ghost">
                Clear
              </Button>
            </Link>
          ) : null}
        </div>
      </form>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          We couldn&apos;t load your audits. Please refresh the page.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
          <p className="text-sm font-medium text-neutral-900">
            {filtersActive
              ? 'No audits match those filters.'
              : after
                ? 'No more audits to show.'
                : 'No audits yet.'}
          </p>
          {!filtersActive && !after ? (
            <p className="mx-auto mt-2 max-w-md text-sm text-neutral-600">
              Upload a PDF wireless bill to start. You&apos;ll get a savings report in under five
              minutes — or browse a real sample first.
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {filtersActive ? (
              <Link href="/audits">
                <Button>Clear filters</Button>
              </Link>
            ) : (
              <>
                <Link href={after ? '/audits' : '/audits/new'}>
                  <Button>{after ? 'Back to start' : 'Upload a bill'}</Button>
                </Link>
                {!after ? (
                  <Link href="/share/verizon_business_large_sample_v1">
                    <Button variant="outline">See a sample audit</Button>
                  </Link>
                ) : null}
              </>
            )}
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
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3 text-neutral-700">{formatDate(row.created_at)}</td>
                  <td className="px-4 py-3 text-neutral-900">
                    <span className="block max-w-xs truncate">{row.original_filename}</span>
                  </td>
                  <td className="px-4 py-3 text-neutral-700">
                    {row.carrier ? (CARRIER_LABELS[row.carrier] ?? row.carrier) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.status} />
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

      {(after || nextCursor) && rows.length > 0 ? (
        <div className="flex items-center justify-between">
          <div>
            {after ? (
              <Link href={firstPageHref}>
                <Button variant="outline" size="sm">
                  ← First page
                </Button>
              </Link>
            ) : null}
          </div>
          <div>
            {nextCursor ? (
              <Link href={buildHref({ after: nextCursor, q, status })}>
                <Button variant="outline" size="sm">
                  Next →
                </Button>
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
