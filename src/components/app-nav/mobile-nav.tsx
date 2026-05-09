'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

export interface MobileNavItem {
  href: string;
  label: string;
}

export interface MobileNavProps {
  items: ReadonlyArray<MobileNavItem>;
  email: string | null;
}

export function MobileNav({ items, email }: MobileNavProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the menu whenever the route changes (navigation completed).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
      >
        {open ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M4.28 4.22a.75.75 0 011.06 0L10 8.94l4.66-4.72a.75.75 0 111.07 1.05L11.06 10l4.67 4.72a.75.75 0 11-1.07 1.06L10 11.06l-4.66 4.72a.75.75 0 11-1.06-1.06L8.94 10 4.28 5.28a.75.75 0 010-1.06z"
              clipRule="evenodd"
            />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M3 5.75A.75.75 0 013.75 5h12.5a.75.75 0 010 1.5H3.75A.75.75 0 013 5.75zm0 4.25A.75.75 0 013.75 9.25h12.5a.75.75 0 010 1.5H3.75A.75.75 0 013 10zm0 4.25a.75.75 0 01.75-.75h12.5a.75.75 0 010 1.5H3.75a.75.75 0 01-.75-.75z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </button>

      {open ? (
        <div
          id="mobile-nav-panel"
          role="dialog"
          aria-modal="false"
          aria-label="Site navigation"
          className="absolute inset-x-0 top-14 z-30 border-b border-neutral-200 bg-white shadow-sm"
        >
          <nav className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-3 text-sm text-neutral-700">
            {items.map((item) => {
              const active =
                pathname === item.href ||
                pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded-md px-3 py-2 hover:bg-neutral-100 hover:text-neutral-900',
                    active &&
                      'bg-neutral-100 font-medium text-neutral-900',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-neutral-200 px-3 pt-3">
              {email ? (
                <p className="truncate text-xs text-neutral-500">
                  Signed in as {email}
                </p>
              ) : (
                <span />
              )}
              <form action="/auth/signout" method="post">
                <button
                  type="submit"
                  className="inline-flex h-8 items-center justify-center rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-900 hover:bg-neutral-100"
                >
                  Sign out
                </button>
              </form>
            </div>
          </nav>
        </div>
      ) : null}
    </div>
  );
}
