'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import { Suspense, useEffect, type ReactNode } from 'react';

import { initPostHog } from '@/lib/posthog/client';
import { env } from '@/env';

type PostHogProviderProps = {
  children: ReactNode;
};

/**
 * Initializes PostHog once on mount and emits manual `$pageview` events on
 * App Router path / search-param changes. Renders children unwrapped because
 * posthog-js does not require a React context provider.
 *
 * No-op (just renders children) when the public PostHog key is missing.
 */
export function PostHogProvider({ children }: PostHogProviderProps) {
  if (!env.NEXT_PUBLIC_POSTHOG_KEY) {
    return <>{children}</>;
  }

  return (
    <PostHogInner>
      {children}
    </PostHogInner>
  );
}

function PostHogInner({ children }: PostHogProviderProps) {
  useEffect(() => {
    initPostHog();
  }, []);

  return (
    <>
      <Suspense fallback={null}>
        <PostHogPageView />
      </Suspense>
      {children}
    </>
  );
}

function PostHogPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;
    if (typeof window === 'undefined') return;

    const search = searchParams?.toString();
    const url = search ? `${window.origin}${pathname}?${search}` : `${window.origin}${pathname}`;

    posthog.capture('$pageview', { $current_url: url });
  }, [pathname, searchParams]);

  return null;
}
