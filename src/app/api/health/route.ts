/**
 * GET /api/health
 *
 * Lightweight liveness + dependency check. Probes the Supabase service-role
 * connection, Stripe API auth, and Anthropic key presence.
 *
 * Always returns 200 — many uptime monitors prefer a static 200 with the
 * actual status carried in the body. Aggregate `status` is 'ok' when every
 * check is ok|skipped|configured, else 'degraded'.
 *
 * Anthropic is intentionally NOT called: a real request burns LLM credit per
 * health probe, so we only confirm the key is present.
 */
import { NextResponse } from 'next/server';

import { env } from '@/env';
import { getAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DbCheck = {
  status: 'ok' | 'fail' | 'skipped';
  latency_ms?: number;
  error?: string;
};
type StripeCheck = { status: 'ok' | 'fail' | 'skipped'; error?: string };
type AnthropicCheck = { status: 'configured' | 'missing' };

interface HealthBody {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: {
    db: DbCheck;
    stripe: StripeCheck;
    anthropic: AnthropicCheck;
  };
}

async function checkDb(): Promise<DbCheck> {
  const start = Date.now();
  try {
    const supabase = getAdminClient();
    const { error } = await supabase.from('profiles').select('id').limit(1);
    const latency = Date.now() - start;
    if (error) {
      return { status: 'fail', latency_ms: latency, error: error.message };
    }
    return { status: 'ok', latency_ms: latency };
  } catch (err) {
    return {
      status: 'fail',
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

async function checkStripe(): Promise<StripeCheck> {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { status: 'skipped' };
  }
  try {
    const stripe = getStripe();
    await stripe.products.list({ limit: 1 });
    return { status: 'ok' };
  } catch (err) {
    return {
      status: 'fail',
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

function checkAnthropic(): AnthropicCheck {
  return env.ANTHROPIC_API_KEY ? { status: 'configured' } : { status: 'missing' };
}

export async function GET(): Promise<Response> {
  const [db, stripe] = await Promise.all([checkDb(), checkStripe()]);
  const anthropic = checkAnthropic();

  const allOk =
    (db.status === 'ok' || db.status === 'skipped') &&
    (stripe.status === 'ok' || stripe.status === 'skipped') &&
    anthropic.status === 'configured';

  const body: HealthBody = {
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks: { db, stripe, anthropic },
  };

  // Single concise log line for ops dashboards. No PII.
  console.log(
    `[health] status=${body.status} db=${db.status} stripe=${stripe.status} anthropic=${anthropic.status}`,
  );

  return NextResponse.json(body, { status: 200 });
}
