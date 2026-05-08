import * as Sentry from '@sentry/nextjs';

// Browser-side Sentry initialization. No-op when DSN is missing so local dev
// without observability env vars stays quiet. Replay is intentionally disabled
// in v1 (see CLAUDE.md §6 Phase 0) to avoid capturing PII from bill content.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}
