import { PostHog } from 'posthog-node';

import { env } from '@/env';

let client: PostHog | null = null;

/**
 * Lazy-initialized PostHog Node client singleton for server-side capture.
 * Returns `null` when `POSTHOG_API_KEY` is unset (e.g. local dev) so callers
 * can short-circuit cleanly.
 *
 * // Caller must call shutdown() at end of request — server client batches events.
 */
export function getPostHogServer(): PostHog | null {
  if (!env.POSTHOG_API_KEY) return null;
  if (client) return client;

  client = new PostHog(env.POSTHOG_API_KEY, {
    host: env.NEXT_PUBLIC_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
  return client;
}
