import * as Sentry from '@sentry/nextjs';

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
    Sentry.captureException(error, {
      tags: { surface: 'rate_limit' },
      extra: { key },
    });
    throw new Error('rate_limit_unavailable');
  }

  const row = coerceRateLimitRow(data);
  if (!row) {
    Sentry.captureMessage('rate_limit.malformed_response', {
      level: 'warning',
      extra: { key },
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
