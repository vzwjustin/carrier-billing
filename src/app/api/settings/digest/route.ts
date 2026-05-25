/**
 * POST /api/settings/digest — authenticated digest opt-in/out toggle.
 *
 * Body: { opt_out: boolean }
 *
 * Flips `profiles.digest_opt_out` for the signed-in user. The corresponding
 * unauthenticated GET unsubscribe endpoint at `/api/email/unsubscribe`
 * serves the public one-click flow.
 */
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  opt_out: z.boolean(),
});

export async function POST(request: Request): Promise<Response> {
  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(bodyJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const limit = await consumeRateLimit({
      key: `settings-digest:${user.id}`,
      limit: 30,
      windowSeconds: 60,
    });
    if (!limit.ok) {
      return rateLimitedResponse(limit.resetAt);
    }

    const admin = getAdminClient();
    const { error } = await admin
      .from('profiles')
      .update({
        digest_opt_out: parsed.data.opt_out,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);
    if (error) {
      Sentry.captureException(error, {
        tags: { surface: 'settings.digest.update' },
        extra: { userId: user.id },
      });
      return NextResponse.json(
        { error: 'Failed to update preferences.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, opt_out: parsed.data.opt_out });
  } catch (err) {
    Sentry.captureException(err, { tags: { surface: 'settings.digest' } });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
