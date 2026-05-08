/**
 * Browser-only analytics tracker. Safe to import from client components.
 * Does NOT pull in posthog-node — that lives in `./server`.
 */
import posthog from 'posthog-js';

import type { AnalyticsEvent } from './events';

export function trackClient(event: AnalyticsEvent, distinctId?: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (distinctId) {
      posthog.identify(distinctId);
    }
    posthog.capture(event.name, event.properties);
  } catch {
    // Analytics must never break product flow.
  }
}
