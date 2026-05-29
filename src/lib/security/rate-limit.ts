import * as Sentry from '@sentry/nextjs';

import { scrubString } from '@/lib/observability/redact';
import { getAdminClient } from '@/lib/supabase/admin';

export type RateLimitConfig = {
  key: string;
  limit: number;
  windowSeconds: number;
};

type RateLimitRow = {
  allowed: boolean;
  remaining: number;
  reset_at: string;
};

export type RateLimitResult =
  | { ok: true; remaining: number; resetAt: string }
  | { ok: false; remaining: number; resetAt: string };

function isRateLimitRow(value: unknown): value is RateLimitRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['allowed'] === 'boolean' &&
    typeof row['remaining'] === 'number' &&
    typeof row['reset_at'] === 'string'
  );
}

function coerceRateLimitRow(data: unknown): RateLimitRow | null {
  if (isRateLimitRow(data)) return data;
  if (Array.isArray(data) && isRateLimitRow(data[0])) return data[0];
  return null;
}

// One-shot warning so a missing rate-limit RPC in local dev is surfaced once
// per Node process instead of spamming the console on every request.
const warnedMissingRpcKeys = new Set<string>();

function isMissingRpcError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const code = (value as { code?: string }).code;
  // PGRST202: PostgREST function-not-found.  42883: PostgreSQL
  // "function does not exist". Both surface here when migration 0016
  // (consume_rate_limit) hasn't been applied yet.
  return code === 'PGRST202' || code === '42883';
}

export async function consumeRateLimit({
  key,
  limit,
  windowSeconds,
}: RateLimitConfig): Promise<RateLimitResult> {
  if (process.env.NODE_ENV === 'test') {
    return {
      ok: true,
      remaining: limit - 1,
      resetAt: new Date(Date.now() + windowSeconds * 1000).toISOString(),
    };
  }

  const admin = getAdminClient();
  const { data, error } = await admin.rpc('consume_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    // Local-dev safety: when the rate-limit infrastructure migration
    // (supabase/migrations/0016_audit_rate_limits_and_credit_consumed.sql)
    // hasn't been applied, fail-open with a one-time warning instead of
    // bricking every auth and audit-create surface. Production keeps the
    // strict fail-closed behaviour so a real outage isn't masked — unless
    // the operator explicitly opts in via ALLOW_PARTIAL_SCHEMA=1 (used for
    // demo environments running against an under-migrated Supabase project).
    const allowPartialSchema =
      process.env.NODE_ENV !== 'production' || process.env.ALLOW_PARTIAL_SCHEMA === '1';
    if (isMissingRpcError(error) && allowPartialSchema) {
      if (!warnedMissingRpcKeys.has(key)) {
        warnedMissingRpcKeys.add(key);
        const safeKey = scrubString(key);
        console.warn(
          `[rate-limit] consume_rate_limit RPC missing on the database — ` +
            `failing open for key="${safeKey}" (dev only). Apply migration 0016 to enable enforcement.`,
        );
      }
      return {
        ok: true,
        remaining: limit - 1,
        resetAt: new Date(Date.now() + windowSeconds * 1000).toISOString(),
      };
    }
    const safeKey = scrubString(key);
    Sentry.captureException(error, {
      tags: { surface: 'rate_limit' },
      extra: { key: safeKey },
    });
    throw new Error('rate_limit_unavailable');
  }

  const row = coerceRateLimitRow(data);
  if (!row) {
    Sentry.captureMessage('rate_limit.malformed_response', {
      level: 'warning',
      extra: { key: scrubString(key) },
    });
    throw new Error('rate_limit_unavailable');
  }

  return row.allowed
    ? { ok: true, remaining: row.remaining, resetAt: row.reset_at }
    : { ok: false, remaining: row.remaining, resetAt: row.reset_at };
}

export function rateLimitedResponse(resetAt: string): Response {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((Date.parse(resetAt) - Date.now()) / 1000),
  );
  return Response.json(
    {
      error: 'rate_limited',
      message: 'Too many requests. Please try again later.',
    },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSeconds) },
    },
  );
}
