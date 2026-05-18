import Link from 'next/link';
import { redirect } from 'next/navigation';

import { MobileNav } from '@/components/app-nav/mobile-nav';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/roadmap', label: 'Roadmap' },
  { href: '/carriers', label: 'Carriers' },
  { href: '/carriers/bills', label: 'Bill editor' },
  { href: '/audits/new', label: 'New audit' },
  { href: '/settings', label: 'Settings' },
  { href: '/settings/billing', label: 'Billing' },
] as const;

interface ProfileRow {
  audit_credits: number | null;
  subscription_status: string | null;
  role: string | null;
}

function isProfileRow(value: unknown): value is ProfileRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.audit_credits === null || typeof v.audit_credits === 'number') &&
    (v.subscription_status === null ||
      typeof v.subscription_status === 'string') &&
    (v.role === null || typeof v.role === 'string')
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
    .select('audit_credits,subscription_status,role')
    .eq('id', user.id)
    .maybeSingle();

  const profile = isProfileRow(profileData) ? profileData : null;
  const badge = getBadgeState(profile);
  const navItems =
    profile?.role === 'admin'
      ? [...NAV_ITEMS, { href: '/admin', label: 'Admin' }]
      : NAV_ITEMS;

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 dark:bg-neutral-950">
      <header className="relative border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link
              href="/dashboard"
              className="text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-100"
            >
              CarrierAudit
            </Link>
            <nav className="hidden items-center gap-4 text-sm text-neutral-600 sm:flex dark:text-neutral-400">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="hover:text-neutral-900 dark:hover:text-neutral-100"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:block">
              <ThemeToggle />
            </div>
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
            <span className="hidden text-sm text-neutral-500 lg:inline">
              {user.email}
            </span>
            <form action="/auth/signout" method="post" className="hidden sm:block">
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
            <MobileNav items={navItems} email={user.email ?? null} />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {profile?.subscription_status === 'past_due' ? (
          <div className="mb-6">
            <Banner
              variant="warning"
              title="Your subscription is past due"
              description="Your last payment failed. Update your payment method to keep running audits."
              action={{ label: 'Update payment', href: '/billing/past-due' }}
            />
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
