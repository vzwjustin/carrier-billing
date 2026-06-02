import { randomBytes } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { env } from '@/env';
import { trackServer } from '@/lib/analytics/events';
import { scrubString } from '@/lib/observability/redact';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { isShareTokenExpired } from '@/lib/share-token';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

interface AuditTokenRow {
  id: string;
  user_id: string;
  status: string;
  share_token: string | null;
  share_token_expires_at: string | null;
}

function matchedExactlyOneAudit(rows: unknown): boolean {
  return Array.isArray(rows) && rows.length === 1;
}

// Share tokens expire 30 days after creation. Re-sharing extends the window
// (the POST handler regenerates the expiry on idempotent calls).
const SHARE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

function buildShareUrl(token: string): string {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
  return `${base}/share/${token}`;
}

async function trackShared(auditId: string, userId: string): Promise<void> {
  try {
    await trackServer({ name: 'report_shared', properties: { auditId } }, userId);
  } catch {
    // analytics never breaks product flow
  }
}

function reportUnexpectedError(err: unknown, surface: string, auditId: string): void {
  Sentry.captureException(
    new Error(scrubString(err instanceof Error ? err.message : String(err))),
    {
      tags: { surface },
      extra: { auditId },
    },
  );
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid audit id.' }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    // RLS limits this to audits owned by the current user, but we still
    // belt-and-suspenders the user_id check below (mirrors start/route.ts:68
    // and retry/route.ts).
    const { data: existing, error: fetchError } = await supabase
      .from('audits')
      .select('id,user_id,status,share_token,share_token_expires_at')
      .eq('id', parsed.data.id)
      .maybeSingle<AuditTokenRow>();

    if (fetchError) {
      return NextResponse.json({ error: 'Failed to look up audit.' }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    if (existing.user_id !== user.id) {
      // M-A1 — RLS should have hidden this row, but verify ownership
      // explicitly so a service-role-leaning future change can't open a hole.
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    if (existing.status !== 'completed') {
      return NextResponse.json({ error: 'audit_not_completed' }, { status: 409 });
    }

    const limit = await consumeRateLimit({
      key: `audit-share:${user.id}:${existing.id}`,
      limit: 20,
      windowSeconds: 60 * 60,
    });
    if (!limit.ok) {
      return rateLimitedResponse(limit.resetAt);
    }

    const admin = getAdminClient();
    const newExpiry = new Date(Date.now() + SHARE_TOKEN_TTL_MS).toISOString();

    // Reuse existing, non-expired token; refresh the expiry on share clicks
    // so an active sharer gets a sliding 30-day window.
    if (existing.share_token && !isShareTokenExpired(existing.share_token_expires_at)) {
      const { data: refreshedRows, error: refreshError } = await admin
        .from('audits')
        .update({ share_token_expires_at: newExpiry })
        .eq('id', existing.id)
        .eq('user_id', user.id)
        .eq('status', 'completed')
        .select('id');
      if (refreshError) {
        return NextResponse.json({ error: 'Failed to save share token.' }, { status: 500 });
      }
      if (!matchedExactlyOneAudit(refreshedRows)) {
        return NextResponse.json({ error: 'audit_not_completed' }, { status: 409 });
      }
      await trackShared(existing.id, user.id);
      return NextResponse.json({ url: buildShareUrl(existing.share_token) });
    }

    // No token, or the existing one expired — mint a fresh one with a fresh
    // expiry. Overwriting an expired token revokes prior public links cleanly.
    const token = generateToken();
    const { data: updatedRows, error: updateError } = await admin
      .from('audits')
      .update({ share_token: token, share_token_expires_at: newExpiry })
      .eq('id', existing.id)
      .eq('user_id', user.id)
      .eq('status', 'completed')
      .select('id');

    if (updateError) {
      return NextResponse.json({ error: 'Failed to save share token.' }, { status: 500 });
    }
    if (!matchedExactlyOneAudit(updatedRows)) {
      return NextResponse.json({ error: 'audit_not_completed' }, { status: 409 });
    }

    await trackShared(existing.id, user.id);
    return NextResponse.json({ url: buildShareUrl(token) });
  } catch (err) {
    reportUnexpectedError(err, 'audits.share.post', parsed.data.id);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid audit id.' }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    // Ownership check — we only let the owner revoke their own share token.
    const { data: existing, error: fetchError } = await supabase
      .from('audits')
      .select('id,user_id,status,share_token,share_token_expires_at')
      .eq('id', parsed.data.id)
      .maybeSingle<AuditTokenRow>();

    if (fetchError) {
      return NextResponse.json({ error: 'Failed to look up audit.' }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    if (existing.user_id !== user.id) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }

    // Idempotent: revoking an already-null token is a no-op success.
    const admin = getAdminClient();
    const { data: revokedRows, error: updateError } = await admin
      .from('audits')
      .update({ share_token: null, share_token_expires_at: null })
      .eq('id', existing.id)
      .eq('user_id', user.id)
      .select('id');

    if (updateError) {
      return NextResponse.json({ error: 'Failed to revoke share token.' }, { status: 500 });
    }
    if (!matchedExactlyOneAudit(revokedRows)) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }

    return new Response(null, { status: 204 });
  } catch (err) {
    reportUnexpectedError(err, 'audits.share.delete', parsed.data.id);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
