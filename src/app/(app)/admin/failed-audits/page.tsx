import { RetryButton } from '@/components/admin/retry-button';
import { requireAdmin } from '@/lib/admin/guard';
import { maskEmail } from '@/lib/audit-trail/log';
import { getAdminClient } from '@/lib/supabase/admin';

export const metadata = { title: 'Admin · Failed audits — CarrierAudit' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

interface FailedAuditRow {
  id: string;
  user_id: string;
  original_filename: string | null;
  failure_reason: string | null;
  created_at: string;
}

interface ProfileLookup {
  id: string;
  email: string | null;
}

interface PageProps {
  searchParams?: Promise<{ page?: string }>;
}

function parsePage(raw: string | undefined): number {
  if (typeof raw !== 'string') return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  // Bound page index so a malicious deep-page query can't burn DB time.
  return Math.min(n, 10_000);
}

export default async function AdminFailedAuditsPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  await requireAdmin();
  const admin = getAdminClient();

  const sp = (await searchParams) ?? {};
  const page = parsePage(sp.page);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data, count } = await admin
    .from('audits')
    .select('id, user_id, original_filename, failure_reason, created_at', {
      count: 'exact',
    })
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .range(from, to);

  const rows = (Array.isArray(data) ? data : []) as FailedAuditRow[];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Resolve user emails in a single query, then mask before render.
  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  let emailById = new Map<string, string | null>();
  if (userIds.length > 0) {
    const { data: profileData } = await admin
      .from('profiles')
      .select('id, email')
      .in('id', userIds);
    const profiles = (Array.isArray(profileData) ? profileData : []) as ProfileLookup[];
    emailById = new Map(profiles.map((p) => [p.id, p.email ?? null]));
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Failed audits
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {total.toLocaleString('en-US')} total · page {page} of {totalPages}
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs tracking-wide text-neutral-500 uppercase dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-medium">Created</th>
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 font-medium">Filename</th>
              <th className="px-4 py-2 font-medium">Failure reason</th>
              <th className="px-4 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-t border-neutral-200 align-top dark:border-neutral-800"
              >
                <td className="px-4 py-2 whitespace-nowrap">
                  {new Date(r.created_at).toLocaleString('en-US')}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-neutral-700 dark:text-neutral-300">
                  {maskEmail(emailById.get(r.user_id) ?? null) ?? '—'}
                </td>
                <td className="max-w-[20ch] truncate px-4 py-2" title={r.original_filename ?? ''}>
                  {r.original_filename ?? '—'}
                </td>
                <td className="px-4 py-2 text-xs text-red-700 dark:text-red-400">
                  <span className="break-words whitespace-pre-wrap">{r.failure_reason ?? '—'}</span>
                </td>
                <td className="px-4 py-2 whitespace-nowrap">
                  <RetryButton auditId={r.id} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-6 text-center text-neutral-500 dark:text-neutral-400"
                >
                  No failed audits.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pager page={page} totalPages={totalPages} />
    </section>
  );
}

function Pager({
  page,
  totalPages,
}: {
  page: number;
  totalPages: number;
}): React.JSX.Element | null {
  if (totalPages <= 1) return null;
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);
  const canPrev = page > 1;
  const canNext = page < totalPages;
  return (
    <nav className="flex items-center justify-end gap-2 text-sm">
      <a
        href={`?page=${prev}`}
        aria-disabled={!canPrev}
        className={
          canPrev
            ? 'rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
            : 'pointer-events-none rounded-md border border-neutral-200 px-3 py-1.5 text-neutral-400 dark:border-neutral-800 dark:text-neutral-600'
        }
      >
        Previous
      </a>
      <a
        href={`?page=${next}`}
        aria-disabled={!canNext}
        className={
          canNext
            ? 'rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
            : 'pointer-events-none rounded-md border border-neutral-200 px-3 py-1.5 text-neutral-400 dark:border-neutral-800 dark:text-neutral-600'
        }
      >
        Next
      </a>
    </nav>
  );
}
