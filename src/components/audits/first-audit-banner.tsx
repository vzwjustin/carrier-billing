'use client';

import Link from 'next/link';
import * as React from 'react';

/**
 * First-time tour banner shown on /audits/[id] after the user's *first*
 * completed audit. Surfaces the three big "next thing to try" features
 * (Bill Increase Autopsy, Inventory, AI assistant) so the user doesn't
 * have to discover them via the left nav.
 *
 * Dismissal is local-only: a `localStorage` key keyed by user ID. No DB
 * migration. The trade-off: dismissals don't sync across devices, but we
 * avoid touching the schema for a low-stakes UX flag.
 *
 * SSR safety: this component is `'use client'` and only reads
 * `localStorage` inside a `useEffect`. Until the effect runs we render
 * nothing — so the server-rendered HTML is just an empty fragment. That
 * means no hydration mismatch and no flash for users who've dismissed it.
 */

export interface FirstAuditBannerProps {
  auditId: string;
  userId: string;
}

function storageKey(userId: string): string {
  return `ca-first-audit-tour-dismissed-${userId}`;
}

export function FirstAuditBanner({
  auditId,
  userId,
}: FirstAuditBannerProps): React.JSX.Element | null {
  // null = haven't checked yet (SSR + first paint). false = visible.
  // true = dismissed. Three-state to avoid an SSR/CSR mismatch flicker.
  const [dismissed, setDismissed] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    try {
      const value = window.localStorage.getItem(storageKey(userId));
      setDismissed(value === '1');
    } catch {
      // Private mode / disabled storage — treat as not dismissed so the
      // banner still works.
      setDismissed(false);
    }
  }, [userId]);

  const handleDismiss = React.useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(storageKey(userId), '1');
    } catch {
      // ignore — dismissal will simply not persist across reloads
    }
  }, [userId]);

  if (dismissed !== false) return null;

  return (
    <div
      role="status"
      aria-label="First audit complete — try these next"
      className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-emerald-900">
            Nice — your first audit is ready.
          </p>
          <p className="mt-1 text-sm text-emerald-800">
            Here are three things worth exploring next.
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="self-start rounded-md p-1 text-emerald-700 hover:bg-emerald-100 sm:self-center"
          aria-label="Dismiss"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href={`/audits/${auditId}/autopsy`}
          className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-300 bg-white px-3 text-xs font-medium text-emerald-900 hover:bg-emerald-100"
        >
          Try Bill Increase Autopsy →
        </Link>
        <Link
          href="/inventory"
          className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-300 bg-white px-3 text-xs font-medium text-emerald-900 hover:bg-emerald-100"
        >
          Explore inventory →
        </Link>
        <Link
          href="/assistant"
          className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-300 bg-white px-3 text-xs font-medium text-emerald-900 hover:bg-emerald-100"
        >
          Open the assistant →
        </Link>
      </div>
    </div>
  );
}
