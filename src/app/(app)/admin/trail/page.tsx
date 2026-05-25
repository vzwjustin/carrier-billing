import {
  AUDIT_TRAIL_EVENT_TYPES,
  type AuditTrailEventType,
} from '@/lib/audit-trail/log';
import { requireAdmin } from '@/lib/admin/guard';
import { getAdminClient } from '@/lib/supabase/admin';

export const metadata = { title: 'Admin · Trail — CarrierAudit' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const WINDOW_VALUES = ['24h', '7d', '30d', 'all'] as const;
type WindowValue = (typeof WINDOW_VALUES)[number];

const WINDOW_HOURS: Record<Exclude<WindowValue, 'all'>, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

interface TrailRow {
  id: string;
  user_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_email: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface PageProps {
  searchParams?: Promise<{
    event_type?: string | string[];
    window?: string;
    user?: string;
    page?: string;
  }>;
}

function parsePage(raw: string | undefined): number {
  if (typeof raw !== 'string') return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 10_000);
}

function parseWindow(raw: string | undefined): WindowValue {
  if (typeof raw === 'string' && (WINDOW_VALUES as readonly string[]).includes(raw)) {
    return raw as WindowValue;
  }
  return '7d';
}

/**
 * Accept event_type either as repeated keys (?event_type=a&event_type=b) or
 * as a single CSV string (?event_type=a,b). Filters out unknown values
 * silently — admins shouldn't be able to inject arbitrary text into the
 * IN-clause via URL.
 */
function parseEventTypes(
  raw: string | string[] | undefined,
): AuditTrailEventType[] {
  if (raw === undefined) return [];
  const all: string[] = Array.isArray(raw) ? raw : [raw];
  const flat: string[] = [];
  for (const entry of all) {
    if (typeof entry !== 'string') continue;
    for (const piece of entry.split(',')) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) flat.push(trimmed);
    }
  }
  const known = new Set<string>(AUDIT_TRAIL_EVENT_TYPES);
  return flat.filter((s): s is AuditTrailEventType => known.has(s));
}

function parseUserSearch(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  // Cap to a sane length to keep ILIKE pattern small.
  return trimmed.slice(0, 64);
}

export default async function AdminTrailPage(
  { searchParams }: PageProps,
): Promise<React.JSX.Element> {
  await requireAdmin();
  const admin = getAdminClient();

  const sp = (await searchParams) ?? {};
  const page = parsePage(sp.page);
  const window = parseWindow(sp.window);
  const eventTypes = parseEventTypes(sp.event_type);
  const userQuery = parseUserSearch(sp.user);

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // Build filters BEFORE the terminal order/range. The Supabase JS builder
  // returns a thenable from .range(), so any additional .gte()/.in()/.ilike()
  // calls must happen before the range terminator.
  let builder = admin
    .from('audit_trail_events')
    .select(
      'id, user_id, event_type, entity_type, entity_id, actor_email, metadata, created_at',
      { count: 'exact' },
    );

  if (window !== 'all') {
    const hours = WINDOW_HOURS[window];
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    builder = builder.gte('created_at', since);
  }
  if (eventTypes.length > 0) {
    builder = builder.in('event_type', eventTypes);
  }
  if (userQuery.length > 0) {
    // Match against the masked email prefix already stored in actor_email
    // (e.g. `j***@example.com`). Quote special ILIKE chars to neuter
    // user-supplied wildcards.
    const escaped = userQuery.replace(/[\\%_]/g, (c) => `\\${c}`);
    builder = builder.ilike('actor_email', `${escaped}%`);
  }

  const { data, count } = await builder
    .order('created_at', { ascending: false })
    .range(from, to);
  const rows = (Array.isArray(data) ? data : []) as TrailRow[];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Audit trail
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {total.toLocaleString('en-US')} total · page {page} of {totalPages}
        </p>
      </div>

      <form
        method="get"
        className="grid gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900 md:grid-cols-3"
      >
        <label className="space-y-1">
          <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Window
          </span>
          <select
            name="window"
            defaultValue={window}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7d</option>
            <option value="30d">Last 30d</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">
            User (masked email prefix)
          </span>
          <input
            type="text"
            name="user"
            defaultValue={userQuery}
            placeholder="j***@…"
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Event types
          </legend>
          <select
            name="event_type"
            multiple
            defaultValue={eventTypes}
            size={4}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
          >
            {AUDIT_TRAIL_EVENT_TYPES.map((et) => (
              <option key={et} value={et}>
                {et}
              </option>
            ))}
          </select>
        </fieldset>
        <div className="md:col-span-3">
          <button
            type="submit"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Apply filters
          </button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Actor</th>
              <th className="px-4 py-2 font-medium">Event</th>
              <th className="px-4 py-2 font-medium">Entity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-t border-neutral-200 align-top dark:border-neutral-800"
              >
                <td className="px-4 py-2 whitespace-nowrap font-mono text-xs">
                  {new Date(r.created_at).toLocaleString('en-US')}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-neutral-700 dark:text-neutral-300">
                  {r.actor_email ?? '—'}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{r.event_type}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  {r.entity_type ?? '—'}
                  {r.entity_id ? `:${r.entity_id.slice(0, 8)}` : ''}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-6 text-center text-neutral-500 dark:text-neutral-400"
                >
                  No trail events match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <TrailPager
        page={page}
        totalPages={totalPages}
        window={window}
        userQuery={userQuery}
        eventTypes={eventTypes}
      />
    </section>
  );
}

function TrailPager({
  page,
  totalPages,
  window,
  userQuery,
  eventTypes,
}: {
  page: number;
  totalPages: number;
  window: WindowValue;
  userQuery: string;
  eventTypes: AuditTrailEventType[];
}): React.JSX.Element | null {
  if (totalPages <= 1) return null;
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);
  const canPrev = page > 1;
  const canNext = page < totalPages;

  function buildQuery(p: number): string {
    const params = new URLSearchParams();
    params.set('page', String(p));
    params.set('window', window);
    if (userQuery.length > 0) params.set('user', userQuery);
    for (const et of eventTypes) params.append('event_type', et);
    return `?${params.toString()}`;
  }

  return (
    <nav className="flex items-center justify-end gap-2 text-sm">
      <a
        href={buildQuery(prev)}
        aria-disabled={!canPrev}
        className={
          canPrev
            ? 'rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
            : 'rounded-md border border-neutral-200 px-3 py-1.5 text-neutral-400 dark:border-neutral-800 dark:text-neutral-600 pointer-events-none'
        }
      >
        Previous
      </a>
      <a
        href={buildQuery(next)}
        aria-disabled={!canNext}
        className={
          canNext
            ? 'rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
            : 'rounded-md border border-neutral-200 px-3 py-1.5 text-neutral-400 dark:border-neutral-800 dark:text-neutral-600 pointer-events-none'
        }
      >
        Next
      </a>
    </nav>
  );
}
