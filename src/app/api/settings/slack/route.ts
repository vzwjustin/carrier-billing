/**
 * POST /api/settings/slack — save / clear / update the user's Slack
 * incoming-webhook URL and notify flags.
 *
 * Body: `{ webhook_url: string | null, notify_on_high_finding?: boolean,
 *          notify_on_autopsy?: boolean }`.
 *
 * The webhook URL is trimmed, then validated against the Slack hooks
 * prefix `https://hooks.slack.com/`. The same constraint is also enforced
 * at the DB column level (migration 0033) and at dispatch time inside
 * `send-slack-notification.ts` — defence-in-depth on what's effectively a
 * server-side redirect target.
 *
 * Passing `webhook_url: null` (or an empty string) clears the saved URL
 * and disables notifications for the user — the boolean flags retain
 * their current value so re-pasting a URL later restores the prior
 * preference.
 *
 * Auth: standard Supabase SSR cookie session — must be signed in.
 * Rate-limited at 30/min per user (mirrors /api/settings/digest).
 */
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SLACK_HOOKS_PREFIX = 'https://hooks.slack.com/';

const BodySchema = z.object({
  // `null` or empty string both clear the URL. Anything else must start
  // with the Slack hooks prefix. The 2048 cap matches the OutboundWebhook
  // card pattern.
  webhook_url: z.union([z.string().max(2048), z.null()]),
  notify_on_high_finding: z.boolean().optional(),
  notify_on_autopsy: z.boolean().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const limit = await consumeRateLimit({
    key: `settings-slack:${user.id}`,
    limit: 30,
    windowSeconds: 60,
  });
  if (!limit.ok) {
    return rateLimitedResponse(limit.resetAt);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ error: first?.message ?? 'Invalid request body.' }, { status: 400 });
  }

  const trimmed = parsed.data.webhook_url === null ? null : parsed.data.webhook_url.trim();

  // Treat empty string the same as null — "clear it".
  const nextUrl: string | null = trimmed === null || trimmed.length === 0 ? null : trimmed;

  if (nextUrl !== null && !nextUrl.startsWith(SLACK_HOOKS_PREFIX)) {
    return NextResponse.json(
      {
        error:
          'Slack webhook URLs must start with https://hooks.slack.com/. Generate one at https://api.slack.com/messaging/webhooks.',
      },
      { status: 400 },
    );
  }

  const update: Record<string, unknown> = {
    slack_webhook_url: nextUrl,
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.notify_on_high_finding !== undefined) {
    update['slack_notify_on_high_finding'] = parsed.data.notify_on_high_finding;
  }
  if (parsed.data.notify_on_autopsy !== undefined) {
    update['slack_notify_on_autopsy'] = parsed.data.notify_on_autopsy;
  }

  const admin = getAdminClient();
  const { error } = await admin.from('profiles').update(update).eq('id', user.id);
  if (error) {
    Sentry.captureException(error, {
      tags: { surface: 'settings.slack.update' },
      extra: { userId: user.id },
    });
    return NextResponse.json({ error: 'Could not save Slack settings.' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    has_webhook: nextUrl !== null,
  });
}
