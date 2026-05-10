import { randomBytes } from 'node:crypto';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { env } from '@/env';
import { trackServer } from '@/lib/analytics/events';
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
  share_token: string | null;
  share_token_expires_at: string | null;
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

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now();
}

async function trackShared(auditId: string, userId: string): Promise<void> {
  try {
    await trackServer({ name: 'report_shared', properties: { auditId } }, userId);
  } catch {
    // analytics never breaks product flow
  }
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
      .select('id,user_id,share_token,share_token_expires_at')
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

    const admin = getAdminClient();
    const newExpiry = new Date(Date.now() + SHARE_TOKEN_TTL_MS).toISOString();

    // Reuse existing, non-expired token; refresh the expiry on share clicks
    // so an active sharer gets a sliding 30-day window.
    if (existing.share_token && !isExpired(existing.share_token_expires_at)) {
      const { error: refreshError } = await admin
        .from('audits')
        .update({ share_token_expires_at: newExpiry })
        .eq('id', existing.id);
      if (refreshError) {
        return NextResponse.json({ error: 'Failed to save share token.' }, { status: 500 });
      }
      await trackShared(existing.id, user.id);
      return NextResponse.json({ url: buildShareUrl(existing.share_token) });
    }

    // No token, or the existing one expired — mint a fresh one with a fresh
    // expiry. Overwriting an expired token revokes prior public links cleanly.
    const token = generateToken();
    const { error: updateError } = await admin
      .from('audits')
      .update({ share_token: token, share_token_expires_at: newExpiry })
      .eq('id', existing.id);

    if (updateError) {
      return NextResponse.json({ error: 'Failed to save share token.' }, { status: 500 });
    }

    await trackShared(existing.id, user.id);
    return NextResponse.json({ url: buildShareUrl(token) });
  } catch {
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
      .select('id,user_id,share_token,share_token_expires_at')
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
    const { error: updateError } = await admin
      .from('audits')
      .update({ share_token: null, share_token_expires_at: null })
      .eq('id', existing.id);

    if (updateError) {
      return NextResponse.json({ error: 'Failed to revoke share token.' }, { status: 500 });
    }

    return new Response(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
