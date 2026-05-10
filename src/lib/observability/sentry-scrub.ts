import type { ErrorEvent, EventHint } from '@sentry/nextjs';

import { redactDetails, scrubString } from './redact';

/**
 * Sentry `beforeSend` hook implementation. Walks the high-PII fields of an
 * event payload and applies the canonical redactor to strings (and, for
 * structured fields, the full recursive walk).
 *
 * Defensive: never throws — if anything goes wrong, drop the event rather
 * than risk shipping unredacted PII to Sentry.
 *
 * Returning `null` would drop the event entirely; we keep observability and
 * just scrub the body.
 */
export function scrubSentryEvent(
  event: ErrorEvent,
  _hint?: EventHint,
): ErrorEvent | null {
  try {
    if (typeof event.message === 'string') {
      event.message = scrubString(event.message);
    }
    if (event.exception?.values) {
      for (const ex of event.exception.values) {
        if (typeof ex.value === 'string') {
          ex.value = scrubString(ex.value);
        }
        if (typeof ex.type === 'string') {
          ex.type = scrubString(ex.type);
        }
      }
    }
    if (event.extra && typeof event.extra === 'object') {
      event.extra = redactDetails(event.extra) as typeof event.extra;
    }
    if (event.contexts && typeof event.contexts === 'object') {
      event.contexts = redactDetails(event.contexts) as typeof event.contexts;
    }
    if (event.request) {
      // `request.url` carries query strings — most importantly the share
      // surface's `?token=…`. scrubString redacts long digit runs and
      // emails; share tokens collapse under DIGIT_RUN. We also walk
      // request headers (Cookie, Authorization, Referer all leak).
      if (typeof event.request.url === 'string') {
        event.request.url = scrubString(event.request.url);
      }
      if (event.request.headers && typeof event.request.headers === 'object') {
        const headers = event.request.headers as Record<string, unknown>;
        for (const key of Object.keys(headers)) {
          const value = headers[key];
          if (typeof value === 'string') {
            // Drop the highest-risk credential-bearing headers entirely;
            // scrub everything else.
            const lower = key.toLowerCase();
            if (
              lower === 'cookie' ||
              lower === 'authorization' ||
              lower === 'referer' ||
              lower === 'referrer'
            ) {
              headers[key] = '[REDACTED]';
            } else {
              headers[key] = scrubString(value);
            }
          }
        }
      }
    }
    if (event.user && typeof event.user === 'object') {
      const user = event.user as Record<string, unknown>;
      for (const key of ['email', 'id', 'username', 'ip_address']) {
        const value = user[key];
        if (typeof value === 'string') {
          user[key] = scrubString(value);
        }
      }
    }
    if (event.tags && typeof event.tags === 'object') {
      const tags = event.tags as Record<string, unknown>;
      for (const key of Object.keys(tags)) {
        const value = tags[key];
        if (typeof value === 'string') {
          tags[key] = scrubString(value);
        }
      }
    }
    if (event.breadcrumbs) {
      for (const crumb of event.breadcrumbs) {
        if (typeof crumb.message === 'string') {
          crumb.message = scrubString(crumb.message);
        }
        if (crumb.data && typeof crumb.data === 'object') {
          crumb.data = redactDetails(crumb.data) as typeof crumb.data;
        }
      }
    }
    return event;
  } catch {
    // If the scrubber itself fails, drop the event rather than ship raw PII.
    return null;
  }
}
