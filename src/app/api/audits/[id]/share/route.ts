import { randomBytes } from 'node:crypto';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { env } from '@/env';
import { trackServer } from '@/lib/analytics/events';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

interface AuditTokenRow {
  id: string;
  share_token: string | null;
}

function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

function buildShareUrl(token: string): string {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
  return `${base}/share/${token}`;
}

async function trackShared(auditId: string, userId: string): Promise<void> {
  try {
    await trackServer(
      { name: 'report_shared', properties: { auditId } },
      userId,
    );
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

    // RLS limits this to audits owned by the current user.
    const { data: existing, error: fetchError } = await supabase
      .from('audits')
      .select('id,share_token')
      .eq('id', parsed.data.id)
      .maybeSingle<AuditTokenRow>();

    if (fetchError) {
      return NextResponse.json(
        { error: 'Failed to look up audit.' },
        { status: 500 },
      );
    }
    if (!existing) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }

    if (existing.share_token) {
      // Track even on the idempotent path — every "Share" click is a signal.
      await trackShared(existing.id, user.id);
      return NextResponse.json({ url: buildShareUrl(existing.share_token) });
    }

    const token = generateToken();
    const { error: updateError } = await supabase
      .from('audits')
      .update({ share_token: token })
      .eq('id', existing.id);

    if (updateError) {
      return NextResponse.json(
        { error: 'Failed to save share token.' },
        { status: 500 },
      );
    }

    await trackShared(existing.id, user.id);
    return NextResponse.json({ url: buildShareUrl(token) });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error.' },
      { status: 500 },
    );
  }
}
