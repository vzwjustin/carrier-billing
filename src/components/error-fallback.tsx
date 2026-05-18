'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';

export interface ErrorFallbackProps {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}

/**
 * Shared route-segment error boundary body. Captures to Sentry (matching
 * global-error.tsx) and renders a themed, reset-able fallback. Used by the
 * per-segment error.tsx files so a thrown render in one area doesn't blank
 * the whole app.
 */
export function ErrorFallback({
  error,
  reset,
  title = 'Something went wrong',
}: ErrorFallbackProps): React.JSX.Element {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="mb-2 text-xl font-semibold text-neutral-900 dark:text-neutral-100">
        {title}
      </h1>
      <p className="mb-6 max-w-md text-sm text-neutral-600 dark:text-neutral-400">
        We hit an unexpected error and the team has been notified. You can try
        again, or head back and retry in a moment.
      </p>
      <Button type="button" onClick={() => reset()}>
        Try again
      </Button>
    </div>
  );
}
