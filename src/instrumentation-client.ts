import * as Sentry from '@sentry/nextjs';

import { scrubSentryEvent } from '@/lib/observability/sentry-scrub';

// Browser-side Sentry initialization (was `sentry.client.config.ts` pre-v10).
// No-op when DSN is missing so local dev without observability env vars stays
// quiet. Replay is intentionally disabled in v1 (see CLAUDE.md §6 Phase 0) to
// avoid capturing PII from bill content.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
  });
}

// Required by @sentry/nextjs v10 to instrument App Router navigations. Without
// this export the SDK logs an ACTION REQUIRED warning on every build.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
