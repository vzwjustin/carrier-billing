import * as Sentry from '@sentry/nextjs';

// Node server runtime Sentry initialization. No-op when DSN is missing.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}
