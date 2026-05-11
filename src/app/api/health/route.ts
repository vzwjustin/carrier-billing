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
 *    Probes DB connectivity, Stripe API reachability, and Anthropic key
 *    presence (no API call). Returns the same 200 envelope with per-check
 *    statuses; an individual failing dependency does NOT 5xx the response
 *    so monitors can keep polling.
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

type CheckStatus = 'ok' | 'fail' | 'skipped';
type Check = { status: CheckStatus; detail?: string };

interface HealthBody {
  status: 'ok' | 'degraded';
  mode: 'liveness' | 'deep';
  timestamp: string;
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
  try {
    const admin = getAdminClient();
    // Smallest possible round-trip: HEAD count against a tiny table.
    const { error } = await admin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .limit(1);
    if (error) return { status: 'fail', detail: error.message.slice(0, 120) };
    return { status: 'ok' };
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
    };
  }
}

async function checkStripe(): Promise<Check> {
  try {
    // `balance.retrieve` is the lightest authenticated Stripe call. Returns
    // immediately without touching customer data.
    await getStripe().balance.retrieve();
    return { status: 'ok' };
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
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

  const [db, stripe] = await Promise.all([checkDb(), checkStripe()]);
  const anthropic = checkAnthropic();

  const allOk =
    db.status === 'ok' && stripe.status === 'ok' && anthropic.status === 'ok';

  const body: HealthBody = {
    status: allOk ? 'ok' : 'degraded',
    mode: 'deep',
    timestamp: new Date().toISOString(),
    checks: {
      app: { status: 'ok' },
      db,
      stripe,
      anthropic,
    },
  };

  return NextResponse.json(body, { status: 200 });
}
