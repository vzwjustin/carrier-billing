import { requireAdmin } from '@/lib/admin/guard';
import { getAdminClient } from '@/lib/supabase/admin';

export const metadata = { title: 'Admin · Rate limits — CarrierAudit' };
export const dynamic = 'force-dynamic';

const TOP_N = 50;
const KEY_TRUNCATE = 60;

interface BucketRow {
  key: string;
  count: number;
  window_start: string;
  updated_at: string | null;
}

/**
 * The migration (0016) defines the table as `rate_limit_buckets` and tracks
 * the *start* of the current window plus a count. There is no stored
 * `reset_at` (the window length is supplied by the caller of
 * `consume_rate_limit`). The inspector therefore surfaces window_start as
 * the "window opened" timestamp — operators can correlate against the
 * caller's rate-limit config to compute the reset.
 */
function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffMs = ts - Date.now();
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60_000);
  const future = diffMs >= 0;
  if (minutes < 1) return future ? 'in <1 min' : '<1 min ago';
  if (minutes < 60) return future ? `in ${minutes} min` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return future ? `in ${hours} h` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days} d` : `${days} d ago`;
}

export default async function AdminRateLimitsPage(): Promise<React.JSX.Element> {
  await requireAdmin();
  const admin = getAdminClient();

  const { data } = await admin
    .from('rate_limit_buckets')
    .select('key, count, window_start, updated_at')
    .order('count', { ascending: false })
    .limit(TOP_N);
  const rows = (Array.isArray(data) ? data : []) as BucketRow[];

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Rate-limit buckets
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Top {TOP_N} buckets by current count (from
          <code className="mx-1">rate_limit_buckets</code>). Window length is
          set per-call by the limiter; the column shows when the current
          window opened.
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-medium">Key</th>
              <th className="px-4 py-2 font-medium text-right">Count</th>
              <th className="px-4 py-2 font-medium">Window opened</th>
              <th className="px-4 py-2 font-medium">Last hit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const truncated =
                r.key.length > KEY_TRUNCATE
                  ? `${r.key.slice(0, KEY_TRUNCATE)}…`
                  : r.key;
              return (
                <tr
                  key={r.key}
                  className="border-t border-neutral-200 dark:border-neutral-800"
                >
                  <td
                    className="px-4 py-2 font-mono text-xs text-neutral-800 dark:text-neutral-200"
                    title={r.key}
                  >
                    {truncated}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {r.count.toLocaleString('en-US')}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-xs text-neutral-600 dark:text-neutral-400">
                    {formatRelative(r.window_start)}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-xs text-neutral-600 dark:text-neutral-400">
                    {r.updated_at ? formatRelative(r.updated_at) : '—'}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-6 text-center text-neutral-500 dark:text-neutral-400"
                >
                  No active rate-limit buckets.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
