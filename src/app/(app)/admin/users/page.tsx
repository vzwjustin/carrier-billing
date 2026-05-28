import { RoleToggle } from '@/components/admin/role-toggle';
import { requireAdmin } from '@/lib/admin/guard';
import { getAdminClient } from '@/lib/supabase/admin';

export const metadata = { title: 'Admin · Users — CarrierAudit' };
export const dynamic = 'force-dynamic';

interface UserRow {
  id: string;
  email: string;
  role: 'user' | 'admin';
  audit_credits: number;
  subscription_status: string | null;
  created_at: string;
}

export default async function AdminUsersPage(): Promise<React.JSX.Element> {
  const ctx = await requireAdmin();
  const admin = getAdminClient();

  const { data } = await admin
    .from('profiles')
    .select('id, email, role, audit_credits, subscription_status, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  const users = (Array.isArray(data) ? data : []) as UserRow[];

  return (
    <section className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          <tr>
            <th className="px-4 py-2 font-medium">Email</th>
            <th className="px-4 py-2 font-medium">Credits</th>
            <th className="px-4 py-2 font-medium">Subscription</th>
            <th className="px-4 py-2 font-medium">Joined</th>
            <th className="px-4 py-2 font-medium">Role</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr
              key={u.id}
              className="border-t border-neutral-200 dark:border-neutral-800"
            >
              <td className="px-4 py-2 text-neutral-900 dark:text-neutral-100">
                {u.email}
              </td>
              <td className="px-4 py-2 tabular-nums">{u.audit_credits}</td>
              <td className="px-4 py-2">{u.subscription_status ?? '—'}</td>
              <td className="px-4 py-2">
                {new Date(u.created_at).toLocaleDateString('en-US')}
              </td>
              <td className="px-4 py-2">
                <RoleToggle
                  userId={u.id}
                  role={u.role}
                  self={u.id === ctx.userId}
                />
              </td>
            </tr>
          ))}
          {users.length === 0 ? (
            <tr>
              <td
                colSpan={5}
                className="px-4 py-6 text-center text-neutral-500 dark:text-neutral-400"
              >
                No users.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
