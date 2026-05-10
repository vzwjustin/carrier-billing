import * as Sentry from '@sentry/nextjs';

import { scrubSentryEvent } from '@/lib/observability/sentry-scrub';

// Node server runtime Sentry initialization. No-op when DSN is missing.
//
// `beforeSend` runs the same PII redactor used by the Inngest failure path
// against every event payload. This is the safety net for code paths that
// captureException without manually calling redactDetails — e.g. Zod errors
// thrown deeper in the stack whose `.message` echoes the offending bill body.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
  });
}
