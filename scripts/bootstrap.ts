/**
 * scripts/bootstrap.ts
 *
 * One-shot provisioning script for CarrierAudit.
 *
 * Reads .env.local (does NOT mutate process.env), validates the keys it needs
 * for each enabled sub-task, then provisions:
 *
 *   1. Stripe products + prices (one-time + monthly subscription)
 *   2. (Optional) Stripe webhook endpoint    [--stripe-webhook=<url>]
 *   3. Supabase migration instructions       (printed only — not executed)
 *   4. Supabase storage buckets (`bills`, `reports`)
 *   5. (Optional) Resend sender domain       [--resend-domain=<domain>]
 *
 * Usage:
 *   pnpm tsx scripts/bootstrap.ts [flags]
 *
 * Flags:
 *   --skip-stripe              Skip Stripe entirely
 *   --skip-supabase            Skip Supabase storage setup
 *   --skip-resend              Skip Resend
 *   --stripe-webhook=<url>     Create Stripe webhook endpoint at <url>
 *   --resend-domain=<domain>   Create a Resend sender domain
 *   --dry-run                  Print what would happen but make no API calls
 *   -h, --help                 Show this help
 *
 * The script is idempotent: re-running is safe and existing resources are
 * detected and reused.
 */

import { parseArgs } from 'node:util';
import path from 'node:path';

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

import { loadDotEnvLocal, type EnvMap } from './lib/env-loader';
import { listMigrationFiles } from './lib/migrations-list';
import { findOrCreateProduct, findOrCreatePrice } from './lib/stripe-helpers';
import { ensureBucket } from './lib/supabase-helpers';

// ---------------------------------------------------------------------------
// ANSI helpers (no chalk dep). Keep deliberately small.
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR == null;
const paint = (code: string, text: string): string =>
  useColor ? `${code}${text}${ANSI.reset}` : text;

const ok = (msg: string): void =>
  console.log(`${paint(ANSI.green, '[OK]')} ${msg}`);
const fail = (msg: string): void =>
  console.log(`${paint(ANSI.red, '[FAIL]')} ${msg}`);
const warn = (msg: string): void =>
  console.log(`${paint(ANSI.yellow, '[WARN]')} ${msg}`);
const info = (msg: string): void =>
  console.log(`${paint(ANSI.cyan, '[INFO]')} ${msg}`);
const dim = (msg: string): void => console.log(paint(ANSI.gray, msg));
const heading = (msg: string): void =>
  console.log(`\n${paint(ANSI.bold, msg)}`);

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

type CliOptions = {
  skipStripe: boolean;
  skipSupabase: boolean;
  skipResend: boolean;
  stripeWebhook: string | null;
  resendDomain: string | null;
  dryRun: boolean;
  help: boolean;
};

function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'skip-stripe': { type: 'boolean', default: false },
      'skip-supabase': { type: 'boolean', default: false },
      'skip-resend': { type: 'boolean', default: false },
      'stripe-webhook': { type: 'string' },
      'resend-domain': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    skipStripe: values['skip-stripe'] === true,
    skipSupabase: values['skip-supabase'] === true,
    skipResend: values['skip-resend'] === true,
    stripeWebhook: typeof values['stripe-webhook'] === 'string' ? values['stripe-webhook'] : null,
    resendDomain: typeof values['resend-domain'] === 'string' ? values['resend-domain'] : null,
    dryRun: values['dry-run'] === true,
    help: values.help === true,
  };
}

function printHelp(): void {
  console.log(`CarrierAudit bootstrap

Usage:
  pnpm tsx scripts/bootstrap.ts [flags]

Flags:
  --skip-stripe              Skip Stripe entirely
  --skip-supabase            Skip Supabase storage setup
  --skip-resend              Skip Resend
  --stripe-webhook=<url>     Create Stripe webhook endpoint at <url>
  --resend-domain=<domain>   Create a Resend sender domain
  --dry-run                  Print what would happen but make no API calls
  -h, --help                 Show this help`);
}

// ---------------------------------------------------------------------------
// Env access
// ---------------------------------------------------------------------------

/**
 * Read a key from `.env.local` first, falling back to `process.env`. We do
 * this without merging so that nothing else in the process picks up secrets.
 */
function readEnv(env: EnvMap, key: string): string | null {
  const fromFile = env[key];
  if (typeof fromFile === 'string' && fromFile.length > 0) return fromFile;
  const fromProcess = process.env[key];
  if (typeof fromProcess === 'string' && fromProcess.length > 0) return fromProcess;
  return null;
}

function requireEnv(env: EnvMap, keys: string[]): string[] {
  const missing: string[] = [];
  for (const k of keys) {
    if (readEnv(env, k) == null) missing.push(k);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Result tracking — used by the final summary
// ---------------------------------------------------------------------------

type Status = 'done' | 'skipped' | 'failed';

type SubtaskReport = {
  name: string;
  status: Status;
  notes: string[];
  envSuggestions: Array<{ key: string; value: string }>;
};

function makeReport(name: string): SubtaskReport {
  return { name, status: 'skipped', notes: [], envSuggestions: [] };
}

// ---------------------------------------------------------------------------
// (a) + (b) Stripe
// ---------------------------------------------------------------------------

const ONE_TIME_PRICE_CENTS = 14_900; // $149.00
const SUBSCRIPTION_PRICE_CENTS = 9_900; // $99.00

const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
];

async function setupStripe(
  env: EnvMap,
  opts: CliOptions,
): Promise<SubtaskReport> {
  const report = makeReport('Stripe products & prices');

  if (opts.skipStripe) {
    report.notes.push('Skipped via --skip-stripe.');
    return report;
  }

  const missing = requireEnv(env, ['STRIPE_SECRET_KEY']);
  if (missing.length > 0) {
    report.status = 'failed';
    report.notes.push(`Missing env: ${missing.join(', ')}`);
    fail(`Stripe: missing required env: ${missing.join(', ')}`);
    return report;
  }

  if (opts.dryRun) {
    info('Stripe: dry-run — would search/create products and prices.');
    info(`  - product "CarrierAudit – One-time audit"  price ${ONE_TIME_PRICE_CENTS}c one_time`);
    info(`  - product "CarrierAudit – Unlimited subscription"  price ${SUBSCRIPTION_PRICE_CENTS}c monthly`);
    if (opts.stripeWebhook != null) {
      info(`  - webhook endpoint ${opts.stripeWebhook} for ${WEBHOOK_EVENTS.length} events`);
    }
    report.status = 'done';
    report.notes.push('Dry-run only.');
    return report;
  }

  // Pin the API version that the installed Stripe SDK declares it supports.
  // (Stripe SDK 17 ships type-pinned to `2025-02-24.acacia`.)
  const stripe = new Stripe(readEnv(env, 'STRIPE_SECRET_KEY')!, {
    apiVersion: '2025-02-24.acacia',
  });

  // (a) Products + prices
  heading('Stripe — products & prices');

  const oneTime = await findOrCreateProduct(
    stripe,
    'CarrierAudit – One-time audit',
    'one_time',
  );
  ok(
    `Product (one_time): ${oneTime.product.id} ${oneTime.created ? '(created)' : '(existing)'}`,
  );

  const oneTimePrice = await findOrCreatePrice(
    stripe,
    oneTime.product.id,
    ONE_TIME_PRICE_CENTS,
    null,
  );
  ok(
    `Price   (one_time): ${oneTimePrice.price.id} $${(ONE_TIME_PRICE_CENTS / 100).toFixed(2)} ${oneTimePrice.created ? '(created)' : '(existing)'}`,
  );

  const sub = await findOrCreateProduct(
    stripe,
    'CarrierAudit – Unlimited subscription',
    'subscription',
  );
  ok(
    `Product (subscription): ${sub.product.id} ${sub.created ? '(created)' : '(existing)'}`,
  );

  const subPrice = await findOrCreatePrice(
    stripe,
    sub.product.id,
    SUBSCRIPTION_PRICE_CENTS,
    { interval: 'month' },
  );
  ok(
    `Price   (subscription): ${subPrice.price.id} $${(SUBSCRIPTION_PRICE_CENTS / 100).toFixed(2)}/mo ${subPrice.created ? '(created)' : '(existing)'}`,
  );

  report.envSuggestions.push(
    { key: 'STRIPE_PRICE_ID_ONE_TIME', value: oneTimePrice.price.id },
    { key: 'STRIPE_PRICE_ID_SUBSCRIPTION', value: subPrice.price.id },
  );

  // (b) Webhook endpoint (opt-in)
  if (opts.stripeWebhook != null) {
    heading('Stripe — webhook endpoint');

    // Validate URL shape early.
    try {
      const u = new URL(opts.stripeWebhook);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost') {
        warn(`Webhook URL is not HTTPS: ${opts.stripeWebhook}`);
      }
    } catch {
      report.status = 'failed';
      fail(`Invalid --stripe-webhook URL: ${opts.stripeWebhook}`);
      return report;
    }

    // Idempotency: list existing endpoints and reuse if same URL + same events.
    const existingList = await stripe.webhookEndpoints.list({ limit: 100 });
    const existing = existingList.data.find((e) => e.url === opts.stripeWebhook);

    if (existing) {
      ok(`Webhook endpoint exists: ${existing.id}`);
      const haveAll = WEBHOOK_EVENTS.every((ev) =>
        existing.enabled_events.includes(ev),
      );
      if (!haveAll) {
        await stripe.webhookEndpoints.update(existing.id, {
          enabled_events: WEBHOOK_EVENTS,
        });
        ok(`Webhook endpoint events updated.`);
      }
      report.notes.push(
        `Webhook endpoint ${existing.id} already exists. Signing secret is only revealed at creation — rotate via the Stripe Dashboard if you no longer have it.`,
      );
    } else {
      const created = await stripe.webhookEndpoints.create({
        url: opts.stripeWebhook,
        enabled_events: WEBHOOK_EVENTS,
      });
      ok(`Webhook endpoint created: ${created.id}`);
      if (created.secret) {
        // We intentionally print this exactly once; the user must capture it.
        console.log(
          `${paint(ANSI.bold, 'STRIPE_WEBHOOK_SECRET')} (copy now — Stripe will not show it again):`,
        );
        console.log(`  ${created.secret}`);
        report.envSuggestions.push({
          key: 'STRIPE_WEBHOOK_SECRET',
          value: '<see above>',
        });
      }
    }
  } else {
    dim('Stripe webhook endpoint not requested. Pass --stripe-webhook=<url> to create one.');
  }

  report.status = 'done';
  return report;
}

// ---------------------------------------------------------------------------
// (c) Supabase migrations — informational only
// ---------------------------------------------------------------------------

async function setupSupabaseMigrationsInfo(): Promise<SubtaskReport> {
  const report = makeReport('Supabase migrations (info)');
  heading('Supabase — database migrations');
  info('This script does not run SQL migrations directly.');

  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
  let migrations: string[];
  try {
    migrations = await listMigrationFiles(migrationsDir);
  } catch (err) {
    report.status = 'failed';
    const msg = err instanceof Error ? err.message : String(err);
    report.notes.push(`Could not read ${migrationsDir}: ${msg}`);
    fail(`Supabase: failed to list migrations at ${migrationsDir}: ${msg}`);
    return report;
  }

  if (migrations.length === 0) {
    report.status = 'failed';
    report.notes.push(`No .sql files found in ${migrationsDir}.`);
    fail(`Supabase: no migrations found in ${migrationsDir}.`);
    return report;
  }

  info('Apply the following SQL files in order from supabase/migrations/:');
  for (const m of migrations) {
    console.log(`    - ${m}`);
  }
  console.log('');
  info('Recommended:');
  console.log('    A) Supabase CLI:   supabase db push');
  console.log('    B) Manual:         paste each file into Dashboard → SQL Editor in order.');
  report.status = 'done';
  report.notes.push(`Run the ${migrations.length} migrations manually before using the app.`);
  return report;
}

// ---------------------------------------------------------------------------
// (d) Supabase storage buckets
// ---------------------------------------------------------------------------

async function setupSupabaseStorage(
  env: EnvMap,
  opts: CliOptions,
): Promise<SubtaskReport> {
  const report = makeReport('Supabase storage buckets');

  if (opts.skipSupabase) {
    report.notes.push('Skipped via --skip-supabase.');
    return report;
  }

  const missing = requireEnv(env, [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
  if (missing.length > 0) {
    report.status = 'failed';
    report.notes.push(`Missing env: ${missing.join(', ')}`);
    fail(`Supabase: missing required env: ${missing.join(', ')}`);
    return report;
  }

  heading('Supabase — storage buckets');

  if (opts.dryRun) {
    info('Dry-run — would ensure buckets `bills` and `reports` (private).');
    report.status = 'done';
    return report;
  }

  const supabase = createClient(
    readEnv(env, 'NEXT_PUBLIC_SUPABASE_URL')!,
    readEnv(env, 'SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  for (const name of ['bills', 'reports'] as const) {
    const result = await ensureBucket(supabase, name);
    ok(`Bucket "${result.name}" ${result.created ? 'created' : 'already exists'} (private).`);
  }

  report.status = 'done';
  return report;
}

// ---------------------------------------------------------------------------
// (e) Resend domain (opt-in)
// ---------------------------------------------------------------------------

async function setupResend(
  env: EnvMap,
  opts: CliOptions,
): Promise<SubtaskReport> {
  const report = makeReport('Resend sender domain');

  if (opts.skipResend) {
    report.notes.push('Skipped via --skip-resend.');
    return report;
  }

  if (opts.resendDomain == null) {
    heading('Resend — sender domain');
    info('No --resend-domain=<domain> provided. Skipping creation.');
    info('To send transactional email, add a domain at https://resend.com/domains');
    info('and set RESEND_API_KEY in .env.local.');
    report.status = 'skipped';
    report.notes.push('No --resend-domain flag provided.');
    return report;
  }

  const missing = requireEnv(env, ['RESEND_API_KEY']);
  if (missing.length > 0) {
    report.status = 'failed';
    report.notes.push(`Missing env: ${missing.join(', ')}`);
    fail(`Resend: missing required env: ${missing.join(', ')}`);
    return report;
  }

  heading('Resend — sender domain');

  if (opts.dryRun) {
    info(`Dry-run — would create Resend domain "${opts.resendDomain}".`);
    report.status = 'done';
    return report;
  }

  const resend = new Resend(readEnv(env, 'RESEND_API_KEY')!);
  const created = await resend.domains.create({ name: opts.resendDomain });

  if (created.error != null) {
    // If the domain already exists, treat that as success but inform the user.
    const msg = created.error.message ?? String(created.error);
    if (/already exists/i.test(msg)) {
      ok(`Domain "${opts.resendDomain}" already exists in Resend.`);
      info('Verification status (and any DNS records) are visible at https://resend.com/domains');
      report.status = 'done';
      return report;
    }
    report.status = 'failed';
    fail(`Resend: ${msg}`);
    return report;
  }

  const data = created.data;
  if (data == null) {
    report.status = 'failed';
    fail('Resend returned no data.');
    return report;
  }

  ok(`Domain "${opts.resendDomain}" created (id: ${data.id}).`);
  info('Add the following DNS records, then verify in the Resend dashboard:');

  // The Resend SDK type for `records` may vary by version; treat as opaque rows.
  const records = (data as unknown as { records?: Array<Record<string, unknown>> }).records;
  if (Array.isArray(records) && records.length > 0) {
    for (const r of records) {
      const type = r.type ?? r.record ?? '?';
      const name = r.name ?? '?';
      const value = r.value ?? r.data ?? '?';
      const ttl = r.ttl ?? 'auto';
      console.log(`    ${String(type).padEnd(6)} ${String(name).padEnd(40)} ${String(value)}  TTL=${String(ttl)}`);
    }
  } else {
    info('No DNS records returned — check the Resend dashboard for the records to add.');
  }

  report.status = 'done';
  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  console.log(paint(ANSI.bold, 'CarrierAudit bootstrap'));
  dim(`cwd: ${process.cwd()}`);
  if (opts.dryRun) warn('Running in --dry-run mode. No external APIs will be called.');

  const env = loadDotEnvLocal(process.cwd());
  const envCount = Object.keys(env).length;
  if (envCount === 0) {
    warn('No .env.local found (or it is empty). Falling back to process.env.');
  } else {
    dim(`Loaded ${envCount} keys from .env.local at ${path.join(process.cwd(), '.env.local')}`);
  }

  const reports: SubtaskReport[] = [];

  // Each sub-task runs independently so partial provisioning is possible.
  reports.push(await setupStripe(env, opts));
  reports.push(await setupSupabaseMigrationsInfo());
  reports.push(await setupSupabaseStorage(env, opts));
  reports.push(await setupResend(env, opts));

  // -------------------------------------------------------------------------
  // (f) Final summary
  // -------------------------------------------------------------------------
  heading('Summary');
  for (const r of reports) {
    const tag =
      r.status === 'done'
        ? paint(ANSI.green, '[OK]')
        : r.status === 'skipped'
          ? paint(ANSI.yellow, '[SKIP]')
          : paint(ANSI.red, '[FAIL]');
    console.log(`${tag} ${r.name}`);
    for (const n of r.notes) console.log(`     ${paint(ANSI.gray, n)}`);
  }

  const envSuggestions = reports.flatMap((r) => r.envSuggestions);
  if (envSuggestions.length > 0) {
    heading('Update your .env.local');
    info('Set the following keys (values shown only once — copy now):');
    for (const s of envSuggestions) {
      console.log(`  ${s.key}=${s.value}`);
    }
  }

  const anyFailed = reports.some((r) => r.status === 'failed');
  if (anyFailed) {
    fail('One or more sub-tasks failed. See the messages above.');
    return 1;
  }

  console.log(`\n${paint(ANSI.green, 'Bootstrap finished.')}`);
  return 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    fail('Bootstrap crashed:');
    if (err instanceof Error) {
      console.error(`  ${err.message}`);
      if (err.stack != null) console.error(paint(ANSI.gray, err.stack));
    } else {
      console.error(err);
    }
    process.exit(1);
  },
);
