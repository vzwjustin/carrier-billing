/**
 * Server-only analytics tracker. Imports posthog-node which uses
 * `node:readline` and is not browser-safe — never import from a client
 * component.
 */
import { getPostHogServer } from '@/lib/posthog/server';

import type { AnalyticsEvent } from './events';

/**
 * Capture a typed event from server context. Resolves silently when no
 * PostHog server key is configured. Flushes before returning so events
 * make it out before short-lived serverless invocations terminate.
 */
export async function trackServer(
  event: AnalyticsEvent,
  distinctId: string,
): Promise<void> {
  const client = getPostHogServer();
  if (!client) return;

  try {
    client.capture({
      distinctId,
      event: event.name,
      properties: event.properties,
    });
    await client.shutdown();
  } catch {
    // Analytics must never break product flow.
  }
}
