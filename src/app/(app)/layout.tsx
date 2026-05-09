import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

interface ProfileRow {
  audit_credits: number | null;
  subscription_status: string | null;
}

function isProfileRow(value: unknown): value is ProfileRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.audit_credits === null || typeof v.audit_credits === 'number') &&
    (v.subscription_status === null ||
      typeof v.subscription_status === 'string')
  );
}

interface BadgeState {
  label: string;
  href: string | null;
  className: string;
}

function getBadgeState(profile: ProfileRow | null): BadgeState {
  const status = profile?.subscription_status ?? null;
  const credits = profile?.audit_credits ?? 0;

  if (status === 'active' || status === 'trialing') {
    return {
      label: 'Unlimited',
      href: '/settings/billing',
      className: 'bg-emerald-100 text-emerald-800',
    };
  }
  if (status === 'past_due') {
    return {
      label: 'Past due — renew',
      href: '/settings/billing',
      className: 'bg-amber-100 text-amber-800',
    };
  }
  if (credits > 0) {
    return {
      label: `${credits} credit${credits === 1 ? '' : 's'}`,
      href: '/settings/billing',
      className: 'bg-neutral-100 text-neutral-700',
    };
  }
  return {
    label: 'Out of credits — Upgrade',
    href: '/pricing',
    className: 'bg-red-100 text-red-800',
  };
}

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

  const { data: profileData } = await supabase
    .from('profiles')
    .select('audit_credits,subscription_status')
    .eq('id', user.id)
    .maybeSingle();

  const profile = isProfileRow(profileData) ? profileData : null;
  const badge = getBadgeState(profile);

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
            {badge.href ? (
              <Link
                href={badge.href}
                className={cn(
                  'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium hover:opacity-90',
                  badge.className,
                )}
                aria-label={`Plan status: ${badge.label}`}
              >
                {badge.label}
              </Link>
            ) : (
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                  badge.className,
                )}
              >
                {badge.label}
              </span>
            )}
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
