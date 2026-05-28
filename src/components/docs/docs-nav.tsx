'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const DOCS_PAGES: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/docs', label: 'Overview' },
  { href: '/docs/getting-started', label: 'Getting started' },
  { href: '/docs/rules', label: 'Rules engine' },
  {
    href: '/docs/bill-increase-autopsy',
    label: 'Bill Increase Autopsy',
  },
  { href: '/docs/dispute-packets', label: 'Dispute packets' },
];

export function DocsNav(): React.ReactElement {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Documentation"
      className="flex flex-col gap-1 text-sm"
    >
      <span className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Documentation
      </span>
      {DOCS_PAGES.map((page) => {
        const isActive = pathname === page.href;
        return (
          <Link
            key={page.href}
            href={page.href}
            aria-current={isActive ? 'page' : undefined}
            className={
              isActive
                ? 'rounded-md bg-neutral-900 px-2 py-1.5 text-neutral-50'
                : 'rounded-md px-2 py-1.5 text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900'
            }
          >
            {page.label}
          </Link>
        );
      })}
    </nav>
  );
}
