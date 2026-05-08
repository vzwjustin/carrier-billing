import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link
              href="/dashboard"
              className="text-base font-semibold tracking-tight text-neutral-900"
            >
              CarrierAudit
            </Link>
            <nav className="flex items-center gap-4 text-sm text-neutral-600">
              <Link href="/dashboard" className="hover:text-neutral-900">
                Dashboard
              </Link>
              <Link href="/audits/new" className="hover:text-neutral-900">
                New audit
              </Link>
              <Link href="/settings" className="hover:text-neutral-900">
                Settings
              </Link>
              <Link
                href="/settings/billing"
                className="hover:text-neutral-900"
              >
                Billing
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-neutral-500 sm:inline">
              {user.email}
            </span>
            <form action="/auth/signout" method="post">
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
