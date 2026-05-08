import posthog from 'posthog-js';

import { env } from '@/env';

let initialized = false;

/**
 * Initialize PostHog in the browser. Idempotent — safe to call from multiple
 * mount points. No-op when the public PostHog key is missing so local dev
 * without observability env vars stays quiet.
 *
 * `capture_pageview: false` because we manually capture `$pageview` on
 * Next.js App Router path changes (see PostHogProvider).
 * `person_profiles: 'identified_only'` keeps anonymous traffic from creating
 * profiles — we only create a profile when a user logs in.
 */
export function initPostHog(): void {
  if (initialized) return;
  if (typeof window === 'undefined') return;
  if (!env.NEXT_PUBLIC_POSTHOG_KEY) return;

  posthog.init(env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: env.NEXT_PUBLIC_POSTHOG_HOST,
    capture_pageview: false,
    person_profiles: 'identified_only',
  });
  initialized = true;
}
