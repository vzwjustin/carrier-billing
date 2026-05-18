import { requireAdmin } from '@/lib/admin/guard';
import { getAdminClient } from '@/lib/supabase/admin';

export const metadata = { title: 'Admin — CarrierAudit' };
export const dynamic = 'force-dynamic';

interface RecentAudit {
  id: string;
  status: string;
  carrier: string | null;
  created_at: string;
}

export default async function AdminOverviewPage(): Promise<React.JSX.Element> {
  await requireAdmin();
  const admin = getAdminClient();

  const [usersRes, auditsRes, completedRes] = await Promise.all([
    admin.from('profiles').select('id', { count: 'exact', head: true }),
    admin.from('audits').select('id', { count: 'exact', head: true }),
    admin
      .from('audits')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed'),
  ]);
  const users = usersRes.count ?? 0;
  const audits = auditsRes.count ?? 0;
  const completed = completedRes.count ?? 0;

  const { data } = await admin
    .from('audits')
    .select('id, status, carrier, created_at')
    .order('created_at', { ascending: false })
    .limit(10);
  const recent = (Array.isArray(data) ? data : []) as RecentAudit[];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Users" value={users} />
        <Stat label="Audits" value={audits} />
        <Stat label="Completed audits" value={completed} />
      </div>
      <section className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
        <h2 className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm font-semibold text-neutral-900 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
          Recent audit activity
        </h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-medium">Audit</th>
              <th className="px-4 py-2 font-medium">Carrier</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((a) => (
              <tr
                key={a.id}
                className="border-t border-neutral-200 dark:border-neutral-800"
              >
                <td className="px-4 py-2 font-mono text-xs">
                  {a.id.slice(0, 8)}
                </td>
                <td className="px-4 py-2">{a.carrier ?? '—'}</td>
                <td className="px-4 py-2">{a.status}</td>
                <td className="px-4 py-2">
                  {new Date(a.created_at).toLocaleString('en-US')}
                </td>
              </tr>
            ))}
            {recent.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-6 text-center text-neutral-500 dark:text-neutral-400"
                >
                  No audits yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
        {value}
      </p>
    </div>
  );
}
