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
