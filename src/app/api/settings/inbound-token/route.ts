/**
 * POST /api/settings/inbound-token — mint or revoke the inbound webhook
 * token used by `/api/inbound/finding-status`.
 *
 * Body: `{ action: 'generate' | 'revoke' }`.
 *
 * Generate returns the freshly-minted token in the JSON response (the only
 * time the plaintext crosses the RSC boundary — the settings page UI is
 * expected to surface it once and let the user copy it). Revoke nulls the
 * column and returns `{ ok: true }`.
 *
 * Auth: standard Supabase SSR cookie session — must be signed in.
 *
 * Mutating endpoint, so we run it as a Route Handler rather than a Server
 * Action to keep the CSRF / fetch / clipboard story explicit on the client.
 */
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { generateInboundWebhookToken } from '@/lib/inbound/webhook-token';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  action: z.enum(['generate', 'revoke']),
});

export async function POST(request: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const admin = getAdminClient();

  if (parsed.data.action === 'revoke') {
    const { error } = await admin
      .from('profiles')
      .update({
        inbound_webhook_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);
    if (error) {
      Sentry.captureException(error, {
        tags: { surface: 'inbound_token.revoke' },
      });
      return NextResponse.json({ error: 'Could not revoke token.' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  // generate — retry on unique-index collision (23505). With 192 bits of
  // entropy this is effectively impossible, but the same defensive loop is
  // already used for the email token in `getOrCreateInboundToken`.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = generateInboundWebhookToken();
    const { error } = await admin
      .from('profiles')
      .update({
        inbound_webhook_token: fresh,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);
    if (!error) {
      return NextResponse.json({ ok: true, token: fresh });
    }
    if ((error as { code?: string }).code !== '23505') {
      Sentry.captureException(error, {
        tags: { surface: 'inbound_token.generate' },
      });
      return NextResponse.json({ error: 'Could not generate token.' }, { status: 500 });
    }
  }
  return NextResponse.json(
    { error: 'Could not generate token. Please try again.' },
    { status: 500 },
  );
}
