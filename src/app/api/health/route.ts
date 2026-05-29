/**
 * GET /api/health
 *
 * Two modes:
 *
 * 1. Liveness (default) — anonymous, fast. Returns 200 with `checks.app:ok`.
 *    Suitable for uptime monitors that just want to know the process is
 *    serving requests. Burns no vendor quota and reveals no secret state.
 *
 * 2. Deep dependency check (gated) — requires `?token=<HEALTH_SECRET>` to
 *    match the server-side `HEALTH_SECRET` env var via constant-time compare.
 *    Probes DB connectivity, DB latency, Stripe API reachability, LLM provider
 *    presence, worker lag (pending audits older than 5 minutes), and recent
 *    success rate. Returns the same 200 envelope with per-check statuses;
 *    an individual failing dependency does NOT 5xx the response so monitors
 *    can keep polling.
 *
 * SPEC §6 Phase 5.9 mandates a /health endpoint that "checks DB + Stripe +
 * Anthropic reachability". The deep-mode token gate is the trade-off: a
 * fully public deep-check endpoint is an SSRF / quota-burn / fingerprinting
 * risk. Operators set HEALTH_SECRET and configure their internal monitor to
 * include the token.
 */
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { env } from '@/env';
import { getAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CheckStatus = 'ok' | 'fail' | 'skipped' | 'warn';
type Check = {
  status: CheckStatus;
  detail?: string;
  metric?: number | string;
  latency_ms?: number;
};

interface HealthBody {
  status: 'ok' | 'degraded';
  mode: 'liveness' | 'deep';
  timestamp: string;
  uptime_seconds?: number;
  version?: string;
  checks: Record<string, Check>;
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function checkDb(): Promise<Check> {
  const start = Date.now();
  try {
    const admin = getAdminClient();
    // Smallest possible round-trip: HEAD count against a tiny table.
    const { error } = await admin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .limit(1);
    const latency_ms = Date.now() - start;
    if (error) {
      return { status: 'fail', detail: error.message.slice(0, 120), latency_ms };
    }
    // Warn if DB round-trip exceeds 500ms — suggests network or DB pressure.
    const status: CheckStatus = latency_ms > 500 ? 'warn' : 'ok';
    return { status, latency_ms };
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
      latency_ms: Date.now() - start,
    };
  }
}

async function checkStripe(): Promise<Check> {
  const start = Date.now();
  try {
    // `balance.retrieve` is the lightest authenticated Stripe call. Returns
    // immediately without touching customer data.
    await getStripe().balance.retrieve();
    return { status: 'ok', latency_ms: Date.now() - start };
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
      latency_ms: Date.now() - start,
    };
  }
}

function checkAnthropic(): Check {
  // Probe presence only — never burn API credit on a health check. The
  // env loader already rejected placeholder values at startup, so existence
  // here is a strong signal the key is real.
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key === 'string' && key.length > 0) return { status: 'ok' };
  return { status: 'fail', detail: 'missing' };
}

function checkOpenRouter(): Check {
  // Same approach as Anthropic — presence-only. OpenRouter is optional, so
  // an absent key is "skipped" rather than "fail". When USE_OPENROUTER=1
  // (the active deployment mode for Gemini Flash extraction), an absent
  // key would have failed env validation, so reaching here without a key
  // means the operator is not using OpenRouter.
  const key = env.OPENROUTER_API_KEY;
  const enabled = process.env.USE_OPENROUTER === '1';
  if (!enabled) return { status: 'skipped', detail: 'USE_OPENROUTER=0' };
  if (typeof key === 'string' && key.length > 0) return { status: 'ok' };
  return { status: 'fail', detail: 'missing' };
}

/**
 * Worker lag: count audits in pending/extracting/analyzing states that
 * are older than 5 minutes. A healthy worker drains these continuously;
 * accumulation = stuck Inngest, missing keys, or worker crash loop.
 */
async function checkWorkerLag(): Promise<Check> {
  try {
    const admin = getAdminClient();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count, error } = await admin
      .from('audits')
      .select('id', { count: 'exact', head: true })
      .in('status', ['pending', 'extracting', 'analyzing'])
      .lt('created_at', fiveMinutesAgo);

    if (error) {
      return { status: 'fail', detail: error.message.slice(0, 120) };
    }

    const stuck = count ?? 0;
    // 0 stuck = ok; 1-2 stuck = warn (could be transient or known timeout);
    // 3+ stuck = fail (almost certainly broken worker).
    let status: CheckStatus = 'ok';
    if (stuck >= 3) status = 'fail';
    else if (stuck > 0) status = 'warn';
    return {
      status,
      metric: stuck,
      detail: stuck === 0 ? 'no stuck audits' : `${stuck} audit(s) >5min old`,
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
    };
  }
}

/**
 * Recent success rate: of audits created in the last 24h, what fraction
 * reached `completed` status? Low rate signals systematic extraction or
 * rule-engine failure. We return % as `metric` and degrade status if the
 * rate drops below thresholds.
 *
 * Skips the check if fewer than 5 audits in the window (statistical noise).
 */
async function checkSuccessRate(): Promise<Check> {
  try {
    const admin = getAdminClient();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { count: total, error: totalErr } = await admin
      .from('audits')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since);
    if (totalErr) return { status: 'fail', detail: totalErr.message.slice(0, 120) };

    const totalCount = total ?? 0;
    if (totalCount < 5) {
      return {
        status: 'skipped',
        detail: `only ${totalCount} audit(s) in last 24h`,
        metric: totalCount,
      };
    }

    const { count: completed, error: completedErr } = await admin
      .from('audits')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)
      .eq('status', 'completed');
    if (completedErr) return { status: 'fail', detail: completedErr.message.slice(0, 120) };

    const completedCount = completed ?? 0;
    const pct = Math.round((completedCount / totalCount) * 100);

    let status: CheckStatus = 'ok';
    if (pct < 50) status = 'fail';
    else if (pct < 80) status = 'warn';

    return {
      status,
      metric: `${pct}%`,
      detail: `${completedCount}/${totalCount} completed in last 24h`,
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
    };
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const providedToken = url.searchParams.get('token');
  const secret = env.HEALTH_SECRET;
  const wantsDeep = providedToken !== null || url.searchParams.has('deep');

  if (!wantsDeep) {
    const body: HealthBody = {
      status: 'ok',
      mode: 'liveness',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      checks: { app: { status: 'ok' } },
    };
    return NextResponse.json(body, { status: 200 });
  }

  if (!secret) {
    // Deep mode requested but the operator hasn't configured a secret.
    // Refuse rather than fall back to an open deep-check.
    return NextResponse.json(
      {
        status: 'degraded',
        mode: 'deep',
        timestamp: new Date().toISOString(),
        checks: {
          app: { status: 'ok' },
          deep: {
            status: 'skipped',
            detail: 'HEALTH_SECRET not configured',
          },
        },
      } satisfies HealthBody,
      { status: 200 },
    );
  }

  if (!tokenMatches(providedToken, secret)) {
    return new Response('Not found', { status: 404 });
  }

  // Run all probes concurrently so total latency is dominated by the slowest.
  const [db, stripe, workerLag, successRate] = await Promise.all([
    checkDb(),
    checkStripe(),
    checkWorkerLag(),
    checkSuccessRate(),
  ]);
  const anthropic = checkAnthropic();
  const openrouter = checkOpenRouter();

  // Provider check: at least ONE valid LLM provider must be reachable.
  const llmOk = anthropic.status === 'ok' || openrouter.status === 'ok';

  const criticalFail =
    db.status === 'fail' ||
    stripe.status === 'fail' ||
    workerLag.status === 'fail' ||
    successRate.status === 'fail' ||
    !llmOk;
  const anyWarn =
    db.status === 'warn' || workerLag.status === 'warn' || successRate.status === 'warn';

  const body: HealthBody = {
    status: criticalFail ? 'degraded' : anyWarn ? 'degraded' : 'ok',
    mode: 'deep',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    checks: {
      app: { status: 'ok' },
      db,
      stripe,
      anthropic,
      openrouter,
      worker_lag: workerLag,
      success_rate_24h: successRate,
    },
  };

  return NextResponse.json(body, { status: 200 });
}
