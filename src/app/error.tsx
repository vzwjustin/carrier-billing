'use client';

import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';
import { AlertTriangle, RefreshCw, ArrowRight } from 'lucide-react';

import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteNav } from '@/components/marketing/site-nav';

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Route-level error boundary. Sits one layer below `global-error.tsx`,
 * so it preserves the layout shell when a page or server component throws
 * during render. Captures to Sentry and surfaces the digest so support
 * tickets can be tied back to a specific exception.
 */
export default function RouteError({ error, reset }: ErrorPageProps): React.ReactElement {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col bg-white text-neutral-900">
      <SiteNav />
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-600">
            <AlertTriangle className="h-7 w-7" aria-hidden />
          </span>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
            Something went wrong
          </h1>
          <p className="mt-3 max-w-md text-sm text-neutral-600 sm:text-base">
            We hit an unexpected error and have been notified. Try the page again, or head back to
            the dashboard.
          </p>
          {error.digest ? (
            <p className="mt-2 text-xs text-neutral-400">
              Reference: <span className="font-mono">{error.digest}</span>
            </p>
          ) : null}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-neutral-900 px-5 text-sm font-medium text-neutral-50 transition hover:bg-neutral-800"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Try again
            </button>
            <Link
              href="/"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-neutral-300 bg-white px-5 text-sm font-medium text-neutral-900 transition hover:bg-neutral-100"
            >
              Back to home
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
