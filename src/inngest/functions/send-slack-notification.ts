import * as Sentry from '@sentry/nextjs';

import { inngest } from '../client';
import {
  BillComparisonPersistedDataSchema,
  FindingCreatedDataSchema,
  parseEventData,
} from '../events';
import { env } from '@/env';
import { getAdminClient } from '@/lib/supabase/admin';

/**
 * send-slack-notification — POST a small Block Kit payload to the user's
 * configured Slack incoming-webhook URL.
 *
 * Listens for two events:
 *
 *   * `finding.created`  — emitted by the autopsy-escalate route after a
 *                          high-severity finding is created. The notifier
 *                          short-circuits when `severity !== 'high'` or the
 *                          user's `slack_notify_on_high_finding` is off.
 *   * `bill.comparison_persisted` — emitted by src/autopsy/persist.ts after
 *                          a comparison row + drivers are written. The
 *                          notifier short-circuits when the comparison has
 *                          no disputable cents, or when the user's
 *                          `slack_notify_on_autopsy` is off.
 *
 * Best-effort: any failure (no webhook configured, fetch timeout, non-2xx)
 * is logged to Sentry and swallowed. We never throw — a flaky Slack URL
 * shouldn't retry forever and pile up worker concurrency.
 *
 * PII discipline (CLAUDE.md §1#5):
 *   * Payload may carry: severity, rule_id, title, cents, counts, audit/
 *     comparison UUIDs, app links.
 *   * Payload NEVER carries: MDNs, account numbers, raw bill text, employee
 *     names, driver descriptions/summaries. Driver titles ARE included
 *     because the autopsy LLM is prompted to keep them PII-free.
 */

interface ProfileSlackRow {
  id: string;
  slack_webhook_url: string | null;
  slack_notify_on_high_finding: boolean | null;
  slack_notify_on_autopsy: boolean | null;
}

/** Slack only allows incoming webhooks on this host. */
const SLACK_HOOKS_PREFIX = 'https://hooks.slack.com/';

interface SlackBlockKitPayload {
  text: string;
  blocks: ReadonlyArray<Record<string, unknown>>;
}

// ─── high-severity finding listener ──────────────────────────────────────────

export const sendSlackHighFindingFn = inngest.createFunction(
  {
    id: 'send-slack-high-finding',
    // Third-party URL, slow consumers shouldn't pile up. Failures are
    // swallowed so retries aren't strictly necessary, but a single retry
    // softens a transient DNS hiccup.
    concurrency: { limit: 5 },
    retries: 1,
  },
  { event: 'finding.created' },
  async ({ event, step, logger }) => {
    const data = parseEventData('finding.created', event.data, FindingCreatedDataSchema);

    if (data.severity !== 'high') {
      logger.info('sendSlackHighFinding: skipped (not high severity)', {
        findingId: data.findingId,
        severity: data.severity,
      });
      return { skipped: 'not_high_severity' };
    }

    const profile = (await step.run('load-profile', async () =>
      loadSlackProfile(data.userId),
    )) as ProfileSlackRow | null;

    if (!profile?.slack_webhook_url) {
      return { skipped: 'no_webhook' };
    }
    if (profile.slack_notify_on_high_finding === false) {
      return { skipped: 'notify_off' };
    }

    const payload = buildHighFindingPayload({
      auditId: data.auditId,
      findingId: data.findingId,
      ruleId: data.ruleId,
      title: data.title,
      estimatedMonthlySavingsCents: data.estimatedMonthlySavingsCents,
    });

    await step.run('post-slack', async () =>
      postToSlack(profile.slack_webhook_url as string, payload, {
        auditId: data.auditId,
        surface: 'slack.high_finding',
      }),
    );

    logger.info('sendSlackHighFinding: dispatched', {
      auditId: data.auditId,
      findingId: data.findingId,
    });
    return { delivered: true };
  },
);

// ─── autopsy listener ────────────────────────────────────────────────────────

export const sendSlackAutopsyFn = inngest.createFunction(
  {
    id: 'send-slack-autopsy',
    concurrency: { limit: 5 },
    retries: 1,
  },
  { event: 'bill.comparison_persisted' },
  async ({ event, step, logger }) => {
    const data = parseEventData(
      'bill.comparison_persisted',
      event.data,
      BillComparisonPersistedDataSchema,
    );

    if (data.disputableCents <= 0) {
      return { skipped: 'no_disputable_amount' };
    }

    const profile = (await step.run('load-profile', async () =>
      loadSlackProfile(data.userId),
    )) as ProfileSlackRow | null;

    if (!profile?.slack_webhook_url) {
      return { skipped: 'no_webhook' };
    }
    if (profile.slack_notify_on_autopsy === false) {
      return { skipped: 'notify_off' };
    }

    const payload = buildAutopsyPayload({
      comparisonId: data.comparisonId,
      currentAuditId: data.currentAuditId,
      disputableCents: data.disputableCents,
      netChangeCents: data.netChangeCents,
      driversCount: data.driversCount,
    });

    await step.run('post-slack', async () =>
      postToSlack(profile.slack_webhook_url as string, payload, {
        comparisonId: data.comparisonId,
        surface: 'slack.autopsy',
      }),
    );

    logger.info('sendSlackAutopsy: dispatched', {
      comparisonId: data.comparisonId,
      currentAuditId: data.currentAuditId,
    });
    return { delivered: true };
  },
);

// ─── helpers ─────────────────────────────────────────────────────────────────

async function loadSlackProfile(userId: string): Promise<ProfileSlackRow | null> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('profiles')
    .select('id, slack_webhook_url, slack_notify_on_high_finding, slack_notify_on_autopsy')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    Sentry.captureException(error, {
      tags: { surface: 'slack.load_profile' },
      extra: { userId },
    });
    return null;
  }
  return (data ?? null) as ProfileSlackRow | null;
}

function formatCents(cents: number): string {
  // Slack messages don't need locale-aware accounting — a plain "$X.XX"
  // keeps the payload human-readable across every workspace.
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars}.${remainder.toString().padStart(2, '0')}`;
}

interface BuildHighFindingInput {
  auditId: string;
  findingId: string;
  ruleId: string;
  title: string;
  estimatedMonthlySavingsCents: number | null;
}

export function buildHighFindingPayload(input: BuildHighFindingInput): SlackBlockKitPayload {
  const url = `${env.NEXT_PUBLIC_APP_URL}/audits/${input.auditId}#finding-${input.findingId}`;
  const savings = input.estimatedMonthlySavingsCents ?? 0;
  const savingsLine =
    savings > 0
      ? `Estimated monthly savings: *${formatCents(savings)}*`
      : 'No automatic savings estimate available.';

  return {
    text: `New high-severity finding: ${input.title}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'High-severity finding',
          emoji: false,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          // The title comes from rule metadata or driver titles (which the
          // autopsy LLM is instructed to keep PII-free). Cents + rule id.
          text: `*${input.title}*\nRule: \`${input.ruleId}\`\n${savingsLine}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View finding', emoji: false },
            url,
            style: 'primary',
          },
        ],
      },
    ],
  };
}

interface BuildAutopsyInput {
  comparisonId: string;
  currentAuditId: string;
  disputableCents: number;
  netChangeCents: number;
  driversCount: number;
}

export function buildAutopsyPayload(input: BuildAutopsyInput): SlackBlockKitPayload {
  const url = `${env.NEXT_PUBLIC_APP_URL}/audits/${input.currentAuditId}/autopsy/${input.comparisonId}`;
  const direction = input.netChangeCents >= 0 ? 'up' : 'down';
  const netAbs = formatCents(Math.abs(input.netChangeCents));

  return {
    text: `Bill comparison ready — ${formatCents(input.disputableCents)} potentially disputable`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Bill increase autopsy',
          emoji: false,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Your latest bill is *${netAbs} ${direction}* vs. the prior period.\nDisputable: *${formatCents(input.disputableCents)}* across *${input.driversCount}* change driver${input.driversCount === 1 ? '' : 's'}.`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View autopsy',
              emoji: false,
            },
            url,
            style: 'primary',
          },
        ],
      },
    ],
  };
}

interface PostContext {
  surface: string;
  auditId?: string;
  comparisonId?: string;
}

export async function postToSlack(
  url: string,
  payload: SlackBlockKitPayload,
  ctx: PostContext,
): Promise<{ ok: boolean; status: number | null }> {
  // Defense-in-depth: pin to the Slack hooks domain even though the column
  // CHECK constraint and the API route already do. Anything else is a
  // configuration bug we should swallow rather than dispatch to.
  if (!url.startsWith(SLACK_HOOKS_PREFIX)) {
    Sentry.captureMessage('slack: webhook url failed prefix check', {
      level: 'warning',
      tags: { surface: ctx.surface },
      extra: { auditId: ctx.auditId, comparisonId: ctx.comparisonId },
    });
    return { ok: false, status: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      Sentry.captureMessage(`slack: ${response.status}`, {
        level: 'warning',
        tags: { surface: ctx.surface },
        extra: {
          auditId: ctx.auditId,
          comparisonId: ctx.comparisonId,
          status: response.status,
        },
      });
      return { ok: false, status: response.status };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: ctx.surface },
      extra: { auditId: ctx.auditId, comparisonId: ctx.comparisonId },
    });
    return { ok: false, status: null };
  } finally {
    clearTimeout(timeout);
  }
}

export const __testables = {
  buildHighFindingPayload,
  buildAutopsyPayload,
  postToSlack,
  formatCents,
};
