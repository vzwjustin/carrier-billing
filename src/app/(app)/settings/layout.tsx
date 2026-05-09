import Link from 'next/link';

import { cn } from '@/lib/utils';

const NAV = [
  { href: '/settings', label: 'Account' },
  { href: '/settings/billing', label: 'Billing' },
  { href: '/settings/integrations', label: 'Integrations' },
] as const;

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Settings
        </h1>
        <p className="text-sm text-neutral-600">
          Manage your account profile and billing.
        </p>
      </header>

      <div className="grid gap-8 sm:grid-cols-[12rem_1fr]">
        <SettingsNav />
        <div>{children}</div>
      </div>
    </div>
  );
}

function SettingsNav(): React.JSX.Element {
  return (
    <nav aria-label="Settings sections" className="space-y-1">
      {NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            'block rounded-md px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
