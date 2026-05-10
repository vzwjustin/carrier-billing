import * as Sentry from '@sentry/nextjs';

import { scrubSentryEvent } from '@/lib/observability/sentry-scrub';

// Edge runtime Sentry initialization (middleware + edge route handlers).
// See sentry.server.config.ts for the rationale behind beforeSend.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
  });
}
