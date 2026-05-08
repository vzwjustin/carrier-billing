import * as Sentry from '@sentry/nextjs';

// Edge runtime Sentry initialization (middleware + edge route handlers).
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}
