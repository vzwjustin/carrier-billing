'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { scrubString } from '@/lib/observability/redact';

interface AppErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AppError({
  error,
  reset,
}: AppErrorProps): React.JSX.Element {
  useEffect(() => {
    // The root global-error already reports to Sentry; this is the in-app
    // boundary so the chrome (header, nav) stays intact and the user has a
    // visible recovery path.
    if (typeof console !== 'undefined') {
      console.error(
        '[app:boundary]',
        error.digest ?? '(no digest)',
        scrubString(error.message || error.name || 'unknown error'),
      );
    }
  }, [error]);

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
        <svg
          aria-hidden="true"
          className="h-6 w-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m0 3.5h.008v.008H12V16.25Zm-9 .75 9-15.75 9 15.75H3Z"
          />
        </svg>
      </div>
      <h1 className="text-xl font-semibold text-neutral-900">
        Something went wrong loading this page
      </h1>
      <p className="text-sm text-neutral-600">
        We&apos;ve logged the error. You can try again, or head back to your
        dashboard. If this keeps happening, email{' '}
        <a
          className="font-medium text-neutral-900 underline"
          href="mailto:support@carrieraudit.io"
        >
          support@carrieraudit.io
        </a>
        {error.digest ? (
          <>
            {' '}
            and include reference{' '}
            <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs">
              {error.digest}
            </code>
            .
          </>
        ) : (
          '.'
        )}
      </p>
      <div className="mt-2 flex flex-col items-center gap-2 sm:flex-row">
        <Button onClick={() => reset()} size="lg">
          Try again
        </Button>
        <Link href="/dashboard">
          <Button size="lg" variant="outline">
            Back to dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}
