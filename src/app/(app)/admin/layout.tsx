import Link from 'next/link';

import { requireAdmin } from '@/lib/admin/guard';

const ADMIN_NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
] as const;

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requireAdmin();

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Admin
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Restricted area. Every action is re-checked server-side.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        {ADMIN_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {item.label}
          </Link>
        ))}
        <a
          href="/admin/export?type=users"
          className="rounded-md px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Export users CSV
        </a>
        <a
          href="/admin/export?type=audits"
          className="rounded-md px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Export audits CSV
        </a>
      </div>
      <div>{children}</div>
    </div>
  );
}
