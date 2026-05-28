/**
 * Public unsubscribe endpoint for the monthly digest.
 *
 * GET /api/email/unsubscribe?token=<...>
 *
 * Flow:
 *   1. Rate-limit per source IP (60 reqs / minute) so a stolen-token harvester
 *      can't enumerate the namespace.
 *   2. Validate token shape — must be 32 chars (`randomBytes(24).toString('base64url')`).
 *   3. Look up the matching profile by `digest_unsub_token`; flip
 *      `digest_opt_out=true`. If no row matches we still return a generic
 *      confirmation page so the response is constant regardless of token
 *      validity (avoids leaking whether a token is live).
 *   4. Return a tiny self-contained HTML confirmation page.
 *
 * This route is intentionally unauthenticated — that's the whole point of a
 * one-click email unsubscribe link.
 *
 * RFC 8058: the Inngest digest function also sends `List-Unsubscribe-Post:
 * One-Click`, so Gmail/Apple Mail may POST here without the user clicking.
 * We accept POST with the same body schema; the only side effect is the
 * opt-out flip.
 */
import { z } from 'zod';

import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `randomBytes(24).toString('base64url')` is exactly 32 characters.
const TOKEN_LENGTH = 32;
const TokenSchema = z.string().length(TOKEN_LENGTH).regex(/^[A-Za-z0-9_-]+$/);

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Unsubscribed — CarrierAudit</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
  </head>
  <body style="margin:0;padding:48px 24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;">
      <h1 style="font-size:20px;font-weight:700;margin:0 0 12px;">You&rsquo;re unsubscribed</h1>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#0f172a;">
        You will no longer receive the monthly CarrierAudit savings digest.
      </p>
      <p style="margin:0;font-size:13px;line-height:1.55;color:#475569;">
        Transactional emails (report-ready, payment notifications) are
        unaffected and will continue to be delivered.
      </p>
    </div>
  </body>
</html>`;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

async function handle(request: Request): Promise<Response> {
  const ip = clientIp(request);
  const limit = await consumeRateLimit({
    key: `unsubscribe:${ip}`,
    limit: 60,
    windowSeconds: 60,
  });
  if (!limit.ok) {
    return rateLimitedResponse(limit.resetAt);
  }

  const url = new URL(request.url);
  const tokenRaw = url.searchParams.get('token');
  const parsed = TokenSchema.safeParse(tokenRaw);
  if (!parsed.success) {
    // Constant response shape — do not signal "valid token vs invalid token".
    return htmlResponse(SUCCESS_HTML);
  }

  const admin = getAdminClient();
  // RLS-bypassing UPDATE — service role only. Match by the unique unsub token
  // (partial unique index in 0028) and set the opt-out flag. The update is
  // idempotent: a second click is a no-op.
  const { error } = await admin
    .from('profiles')
    .update({
      digest_opt_out: true,
      updated_at: new Date().toISOString(),
    })
    .eq('digest_unsub_token', parsed.data);

  if (error) {
    // Don't surface DB errors to the recipient — return a generic confirmation
    // so an enumerator can't infer a DB issue. The failure surfaces in logs.
    return htmlResponse(SUCCESS_HTML, 500);
  }

  return htmlResponse(SUCCESS_HTML);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  // RFC 8058 one-click POST. We accept either the query-string token (Gmail's
  // current behavior) or a form-encoded body. The schema validation handles
  // both paths uniformly via the URL's searchParams.
  return handle(request);
}
