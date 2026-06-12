import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Placeholder rejection (H17)
// ---------------------------------------------------------------------------
// Even when `SKIP_ENV_VALIDATION=1` lets the Zod schema be bypassed at build
// time, the dashboard config could ship literal `"placeholder"` strings to
// production runtime if it's misconfigured. Such values pass `min(1)` but
// blow up the moment an SDK tries to use them. Reject them loudly here so
// the failure surfaces at startup with a clear message instead of as an
// opaque 500 from Stripe/Anthropic/Supabase later.

const PLACEHOLDER_SECRET_VALUES = new Set<string>([
  'placeholder',
  'sk_placeholder',
  'whsec_placeholder',
  'price_placeholder',
  'changeme',
  'change-me',
  'replace-me',
  'replaceme',
  '__missing_at_build_time__',
]);

export const REQUIRED_SERVER_SECRETS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID_ONE_TIME',
  'STRIPE_PRICE_ID_SUBSCRIPTION',
  'RESEND_API_KEY',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
] as const;

export function isPlaceholderSecret(value: string | undefined): boolean {
  if (!value) return false;
  return PLACEHOLDER_SECRET_VALUES.has(value.toLowerCase());
}

export function assertNoPlaceholderSecrets(source: NodeJS.ProcessEnv = process.env): void {
  const offenders: string[] = [];
  for (const key of REQUIRED_SERVER_SECRETS) {
    if (isPlaceholderSecret(source[key])) offenders.push(key);
  }
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to start: placeholder values detected for required server secrets [${offenders.join(', ')}]. ` +
        'Set real values in your deployment environment (Netlify dashboard for production).',
    );
  }
}

// M2: ALLOW_PARTIAL_SCHEMA is a demo/under-migrated-DB escape hatch read raw
// from process.env in three places (rate-limit.ts, audits/route.ts,
// process-bill.ts) where `=== '1'` flips a fail-OPEN branch — disabling rate
// limiting, the credit gate, and a worker guard respectively. Left unvalidated
// it lets a single env var put a security control + billing path + durable
// worker into fail-open with no production tripwire. Refuse to start in
// production when it's enabled, so the fail-open can never ship silently.
export function assertPartialSchemaNotInProduction(source: NodeJS.ProcessEnv = process.env): void {
  if (source.NODE_ENV === 'production' && source.ALLOW_PARTIAL_SCHEMA === '1') {
    throw new Error(
      'Refusing to start: ALLOW_PARTIAL_SCHEMA=1 is set in production. This ' +
        'flag enables fail-open behavior (rate limiting, credit gate, worker ' +
        'guards) and is intended only for local/demo environments with an ' +
        'under-migrated database. Unset it in production.',
    );
  }
}

// Skip the runtime placeholder check inside the Vitest harness — `tests/setup.ts`
// intentionally fills client-only NEXT_PUBLIC_* vars with placeholder strings,
// and required server secrets are simply absent under tests.
if (process.env.NODE_ENV !== 'test') {
  assertNoPlaceholderSecrets();
  assertPartialSchemaNotInProduction();
}

// ---------------------------------------------------------------------------
// SKIP_ENV_VALIDATION gating (H17)
// ---------------------------------------------------------------------------
// Honored everywhere EXCEPT a Netlify production build/runtime, where we
// always want the full Zod schema to run. Netlify exposes `NETLIFY=true` and
// `CONTEXT` ∈ {production, deploy-preview, branch-deploy, dev}. Outside
// Netlify (local builds, CI inspection, tests) the flag still works as before.
function shouldSkipValidation(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.CI) return true;
  if (!process.env.SKIP_ENV_VALIDATION) return false;
  if (process.env.NETLIFY === 'true' && process.env.CONTEXT === 'production') {
    return false;
  }
  return true;
}

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Supabase
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

    // Anthropic
    ANTHROPIC_API_KEY: z.string().min(1),

    // OpenRouter (optional; enables alt LLM provider — e.g. Gemini Flash via
    // OpenAI-compatible API). Activated by `USE_OPENROUTER=1`. Model name is
    // configurable via `OPENROUTER_MODEL` (defaults to google/gemini-3.5-flash).
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    OPENROUTER_MODEL: z.string().min(1).default('google/gemini-3.5-flash'),

    // AWS Textract (optional — only needed for OCR on scanned PDFs)
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    // S3 staging bucket for the async Textract path. Without this var the
    // async OCR path is unavailable — this is rare in practice and only
    // triggers for >5MB scanned bills (sync Textract handles the rest).
    // Bucket must live in the same region as AWS_REGION.
    AWS_TEXTRACT_S3_BUCKET: z.string().min(1).optional(),

    // Stripe
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),
    STRIPE_PRICE_ID_ONE_TIME: z.string().min(1),
    STRIPE_PRICE_ID_SUBSCRIPTION: z.string().min(1),

    // Inngest. Required in every deployed environment — without these the
    // worker can't authenticate event sends or verify incoming webhooks.
    // For local dev, use the SKIP_ENV_VALIDATION escape hatch (the Inngest
    // dev server doesn't require either key).
    INNGEST_EVENT_KEY: z.string().min(1),
    INNGEST_SIGNING_KEY: z.string().min(1),

    // Resend
    RESEND_API_KEY: z.string().min(1),

    // Inbound email ingest. INBOUND_EMAIL_DOMAIN is the domain users forward
    // bills to (e.g. `inbound.carrieraudit.com`). INBOUND_EMAIL_SECRET is the
    // shared HMAC secret your inbound-email provider (Resend/Postmark/SendGrid)
    // signs the webhook with. Both optional — leave unset in dev to no-op the
    // feature.
    INBOUND_EMAIL_DOMAIN: z.string().min(1).optional(),
    INBOUND_EMAIL_SECRET: z.string().min(16).optional(),

    // Sentry
    SENTRY_DSN: z.string().url().optional(),
    // Sentry build-time (optional — enables sourcemap upload + release tracking)
    SENTRY_ORG: z.string().min(1).optional(),
    SENTRY_PROJECT: z.string().min(1).optional(),
    SENTRY_AUTH_TOKEN: z.string().min(1).optional(),

    // PostHog (server)
    POSTHOG_API_KEY: z.string().min(1).optional(),

    // H4: optional secret for the /api/health deep-dependency probe. When
    // set, callers must pass `?token=<HEALTH_SECRET>` to opt into DB +
    // Stripe-API + Anthropic-key checks. When unset, /api/health remains a
    // pure liveness endpoint (200 / app:ok) — the default-safe behavior.
    HEALTH_SECRET: z.string().min(16).optional(),

    // Recurring bill-upload reminder cron. Default-safe: when unset or not
    // exactly 'true', the monthly job runs in dry-run mode (selects + logs
    // the due-user count but sends no email). Set to 'true' ONLY once a
    // verified Resend sender domain is configured (see FROM_ADDRESS TODO).
    BILL_REMINDER_ENABLED: z.enum(['true', 'false']).optional(),

    // M2: demo/under-migrated-DB escape hatch. '1' flips fail-OPEN branches in
    // rate-limit.ts, audits/route.ts, and process-bill.ts. Declared here so it
    // passes through env validation rather than being read entirely raw; the
    // production tripwire lives in assertPartialSchemaNotInProduction() above.
    ALLOW_PARTIAL_SCHEMA: z.enum(['0', '1']).optional(),
  },
  client: {
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1),
    NEXT_PUBLIC_POSTHOG_KEY: z.string().min(1).optional(),
    NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default('https://us.i.posthog.com'),
    NEXT_PUBLIC_APP_URL: z.string().url(),
    NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: process.env.AWS_REGION,
    AWS_TEXTRACT_S3_BUCKET: process.env.AWS_TEXTRACT_S3_BUCKET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_ID_ONE_TIME: process.env.STRIPE_PRICE_ID_ONE_TIME,
    STRIPE_PRICE_ID_SUBSCRIPTION: process.env.STRIPE_PRICE_ID_SUBSCRIPTION,
    INNGEST_EVENT_KEY: process.env.INNGEST_EVENT_KEY,
    INNGEST_SIGNING_KEY: process.env.INNGEST_SIGNING_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    INBOUND_EMAIL_DOMAIN: process.env.INBOUND_EMAIL_DOMAIN,
    INBOUND_EMAIL_SECRET: process.env.INBOUND_EMAIL_SECRET,
    SENTRY_DSN: process.env.SENTRY_DSN,
    SENTRY_ORG: process.env.SENTRY_ORG,
    SENTRY_PROJECT: process.env.SENTRY_PROJECT,
    SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
    POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
    HEALTH_SECRET: process.env.HEALTH_SECRET,
    BILL_REMINDER_ENABLED: process.env.BILL_REMINDER_ENABLED,
    ALLOW_PARTIAL_SCHEMA: process.env.ALLOW_PARTIAL_SCHEMA,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  },
  skipValidation: shouldSkipValidation(),
  emptyStringAsUndefined: true,
});
