'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import { Suspense, useEffect, type ReactNode } from 'react';

import { initPostHog } from '@/lib/posthog/client';
import { env } from '@/env';

type PostHogProviderProps = {
  children: ReactNode;
};

// Public /share/* surface uses anonymous tokens; server-side trackServer with
// a hashed token is the only allowed analytics path there. Skipping the client
// provider keeps posthog-js from auto-capturing $current_url with the raw token.
function isExcludedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === '/share' || pathname.startsWith('/share/');
}

/**
 * Initializes PostHog once on mount and emits manual `$pageview` events on
 * App Router path / search-param changes. Renders children unwrapped because
 * posthog-js does not require a React context provider.
 *
 * No-op (just renders children) when the public PostHog key is missing or
 * when the current path is the public share surface.
 */
export function PostHogProvider({ children }: PostHogProviderProps) {
  const pathname = usePathname();

  if (!env.NEXT_PUBLIC_POSTHOG_KEY || isExcludedPath(pathname)) {
    return <>{children}</>;
  }

  return <PostHogInner>{children}</PostHogInner>;
}

function PostHogInner({ children }: PostHogProviderProps) {
  useEffect(() => {
    // Defense-in-depth: even though the parent guards on `usePathname()`,
    // the App Router can render this component on a share route during
    // navigation transitions. Re-check `window.location.pathname` *before*
    // posthog.init so the autocapture of $current_url on first init never
    // sees a `/share/<token>` URL.
    if (typeof window !== 'undefined' && window.location.pathname.startsWith('/share/')) {
      return;
    }
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
