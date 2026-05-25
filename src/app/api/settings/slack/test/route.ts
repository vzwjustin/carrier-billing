/**
 * POST /api/settings/slack/test — fire a hello-world Block Kit message to
 * the user's saved Slack webhook URL so they can sanity-check the
 * integration before relying on it.
 *
 * Auth: standard Supabase SSR cookie session. Rate-limited at 6/min/user
 * (lower than the /settings/slack save endpoint — sending real Slack
 * traffic should never be hot).
 *
 * Returns `{ ok: true }` on a 2xx response from Slack; `{ ok: false }`
 * with a human-readable error otherwise. The user's webhook URL is never
 * echoed back in the response or the logs.
 */
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { postToSlack } from '@/inngest/functions/send-slack-notification';
import {
  consumeRateLimit,
  rateLimitedResponse,
} from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const limit = await consumeRateLimit({
    key: `settings-slack-test:${user.id}`,
    limit: 6,
    windowSeconds: 60,
  });
  if (!limit.ok) {
    return rateLimitedResponse(limit.resetAt);
  }

  const admin = getAdminClient();
  const { data, error } = await admin
    .from('profiles')
    .select('slack_webhook_url')
    .eq('id', user.id)
    .maybeSingle();
  if (error) {
    Sentry.captureException(error, {
      tags: { surface: 'settings.slack.test.load' },
      extra: { userId: user.id },
    });
    return NextResponse.json(
      { error: 'Could not load Slack settings.' },
      { status: 500 },
    );
  }
  const url = (data as { slack_webhook_url?: string | null } | null)
    ?.slack_webhook_url;
  if (!url) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Save a Slack webhook URL first.',
      },
      { status: 400 },
    );
  }

  const result = await postToSlack(
    url,
    {
      text: 'CarrierAudit test notification — your Slack integration works.',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'CarrierAudit test notification',
            emoji: false,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'If you can see this, your Slack integration is wired up correctly. You will receive a message whenever a high-severity finding is created or a bill increase autopsy lands with disputable charges.',
          },
        },
      ],
    },
    { surface: 'slack.test' },
  );

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          result.status !== null
            ? `Slack returned ${result.status}. Verify the webhook URL is still active.`
            : 'Could not reach Slack. Check the webhook URL.',
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
