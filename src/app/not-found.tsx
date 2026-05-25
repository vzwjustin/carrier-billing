import Link from 'next/link';
import { FileQuestion, ArrowRight } from 'lucide-react';

import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteNav } from '@/components/marketing/site-nav';

/**
 * Root 404 page. Triggered by any `notFound()` call that isn't caught by
 * a more-specific not-found.tsx in a route segment. Keeps the same nav +
 * footer as marketing pages so a visitor who lands on a stale link still
 * sees a working header and a clear way back into the funnel.
 */
export default function NotFound(): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col bg-white text-neutral-900">
      <SiteNav />
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-100 text-neutral-500">
            <FileQuestion className="h-7 w-7" aria-hidden />
          </span>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
            Page not found
          </h1>
          <p className="mt-3 max-w-md text-sm text-neutral-600 sm:text-base">
            The link is broken, expired, or never existed. If you followed a
            shared report URL, the owner may have rotated the token.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-neutral-900 px-5 text-sm font-medium text-neutral-50 transition hover:bg-neutral-800"
            >
              Back to home
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/pricing"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-neutral-300 bg-white px-5 text-sm font-medium text-neutral-900 transition hover:bg-neutral-100"
            >
              See pricing
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
