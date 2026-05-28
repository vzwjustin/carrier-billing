import { createHmac } from 'node:crypto';

import { inngest } from '../client';
import { FindingStatusChangedDataSchema, parseEventData } from '../events';
import { postPinnedHttps } from '@/lib/security/pinned-https';
import { assertPublicHttpsTarget } from '@/lib/security/ssrf-guard';
import { getAdminClient } from '@/lib/supabase/admin';
import type { FindingSeverity } from '@/types/db-enums';

/**
 * dispatch-finding-webhook — POST a single finding's status transition to the
 * user's configured outbound webhook URL, signed with the same v2 timestamped
 * HMAC-SHA256 scheme as the `audit.completed` dispatcher.
 *
 * Trigger: `finding.status_changed`. The event is fired by both the authed
 * status route (`POST /api/audits/[id]/findings/[findingId]/status`) AND the
 * inbound callback (`POST /api/inbound/finding-status`), so a Slack/Linear
 * round-trip surfaces back to any external automation downstream.
 *
 * Skipped silently if the user has no `outbound_webhook_url` configured.
 *
 * Signature contract (matches dispatch-outbound-webhook):
 *   X-CarrierAudit-Timestamp: <unix-seconds>
 *   X-CarrierAudit-Signature: t=<unix-seconds>,v1=hex(hmac_sha256(`${t}.${body}`, secret))
 *   X-CarrierAudit-Event: finding.status_changed
 *   X-CarrierAudit-Audit-Id: <auditId>
 *   X-CarrierAudit-Finding-Id: <findingId>
 *
 * PII discipline (CLAUDE.md §1#5): payload includes rule_id, severity, title,
 * cents, and status fields. Never includes raw MDN/account/phone numbers
 * (findings don't carry those anyway — they reference line indexes by uuid).
 * Logs only ever include {auditId, findingId, userId, status}.
 */

interface ProfileRow {
  id: string;
  outbound_webhook_url: string | null;
  outbound_webhook_secret: string | null;
}

interface FindingRow {
  id: string;
  audit_id: string;
  rule_id: string;
  severity: FindingSeverity;
  title: string;
  status: string;
  estimated_monthly_savings_cents: number | null;
}

interface AuditOwnerRow {
  id: string;
  user_id: string;
}

export const dispatchFindingWebhookFn = inngest.createFunction(
  {
    id: 'dispatch-finding-webhook',
    // Same conservative settings as the audit dispatcher: third-party URL,
    // slow consumers shouldn't pile up.
    concurrency: { limit: 5 },
    retries: 3,
  },
  { event: 'finding.status_changed' },
  async ({ event, step, logger }) => {
    const { auditId, findingId, status, previousStatus, userId } =
      parseEventData(
        'finding.status_changed',
        event.data,
        FindingStatusChangedDataSchema,
      );

    const ctx = (await step.run('load-context', async () => {
      const admin = getAdminClient();

      const { data: profile, error: profileErr } = await admin
        .from('profiles')
        .select('id, outbound_webhook_url, outbound_webhook_secret')
        .eq('id', userId)
        .maybeSingle();
      if (profileErr) {
        throw new Error(`profile read failed: ${profileErr.message}`);
      }
      const p = (profile ?? null) as ProfileRow | null;
      if (!p?.outbound_webhook_url || !p.outbound_webhook_secret) {
        return { skipped: true as const, reason: 'no_webhook' };
      }

      // Double-check the finding belongs to this user via the parent audit.
      // The producers already verify ownership, but the dispatcher might run
      // long after the producer, and we never want to leak a finding to a
      // webhook URL if ownership shifted in-between (it shouldn't, but
      // defense-in-depth is cheap).
      const { data: audit, error: auditErr } = await admin
        .from('audits')
        .select('id, user_id')
        .eq('id', auditId)
        .maybeSingle();
      if (auditErr) {
        throw new Error(`audit read failed: ${auditErr.message}`);
      }
      const a = (audit ?? null) as AuditOwnerRow | null;
      if (!a || a.user_id !== userId) {
        return { skipped: true as const, reason: 'audit_ownership' };
      }

      const { data: finding, error: findingErr } = await admin
        .from('findings')
        .select(
          'id, audit_id, rule_id, severity, title, status, estimated_monthly_savings_cents',
        )
        .eq('id', findingId)
        .eq('audit_id', auditId)
        .maybeSingle();
      if (findingErr) {
        throw new Error(`finding read failed: ${findingErr.message}`);
      }
      const f = (finding ?? null) as FindingRow | null;
      if (!f) {
        return { skipped: true as const, reason: 'finding_missing' };
      }

      return {
        skipped: false as const,
        url: p.outbound_webhook_url,
        secret: p.outbound_webhook_secret,
        finding: f,
      };
    })) as
      | { skipped: true; reason: string }
      | {
          skipped: false;
          url: string;
          secret: string;
          finding: FindingRow;
        };

    if (ctx.skipped) {
      logger.info('dispatchFindingWebhook: skipped', {
        auditId,
        findingId,
        userId,
        reason: ctx.reason,
      });
      return { skipped: true, reason: ctx.reason };
    }

    const result = (await step.run('post-webhook', async () =>
      postFindingWebhook({
        url: ctx.url,
        secret: ctx.secret,
        auditId,
        findingId,
        status,
        previousStatus,
        finding: ctx.finding,
      }),
    )) as { status: number };

    logger.info('dispatchFindingWebhook: delivered', {
      auditId,
      findingId,
      userId,
      status: result.status,
    });
    return { delivered: true, status: result.status };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Extracted POST logic — kept as a separate function so unit tests can exercise
// the signing + fetch path without spinning up an Inngest runtime. Exported
// via `__testables` (test-only surface).
// ─────────────────────────────────────────────────────────────────────────────

interface PostFindingWebhookInput {
  url: string;
  secret: string;
  auditId: string;
  findingId: string;
  status: string;
  previousStatus: string | null;
  finding: FindingRow;
}

async function postFindingWebhook(
  input: PostFindingWebhookInput,
): Promise<{ status: number }> {
  const {
    url,
    secret,
    auditId,
    findingId,
    status,
    previousStatus,
    finding,
  } = input;

  const payload = {
    event: 'finding.status_changed' as const,
    delivered_at: new Date().toISOString(),
    audit_id: auditId,
    finding_id: findingId,
    status,
    previous_status: previousStatus,
    finding: {
      rule_id: finding.rule_id,
      severity: finding.severity,
      title: finding.title,
      estimated_monthly_savings_cents:
        finding.estimated_monthly_savings_cents ?? 0,
      status: finding.status,
    },
  };

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${body}`;
  const sigHex = createHmac('sha256', secret).update(signedPayload).digest('hex');
  const signatureHeader = `t=${timestamp},v1=${sigHex}`;

  // Re-validate at dispatch time — defeats DNS rebinding by resolving fresh
  // and pinning the connect to the vetted IP via `postPinnedHttps`, which
  // keeps the hostname as TLS SNI so the receiver's cert still validates.
  const target = await assertPublicHttpsTarget(url);
  const original = new URL(url);
  const host =
    original.port.length > 0
      ? `${original.hostname}:${original.port}`
      : original.hostname;

  const { status: responseStatus } = await postPinnedHttps({
    url: original,
    resolvedIp: target.resolvedIp,
    family: target.family,
    headers: {
      'Content-Type': 'application/json',
      Host: host,
      'X-CarrierAudit-Timestamp': String(timestamp),
      'X-CarrierAudit-Signature': signatureHeader,
      'X-CarrierAudit-Event': 'finding.status_changed',
      'X-CarrierAudit-Audit-Id': auditId,
      'X-CarrierAudit-Finding-Id': findingId,
      'User-Agent': 'CarrierAudit-Webhook/1.0',
    },
    body,
    timeoutMs: 15_000,
  });

  if (responseStatus < 200 || responseStatus >= 300) {
    // Throw so Inngest retries. 4xx still throws because we can't tell
    // a transient 401 (e.g. rotating secret on receiver side) from a
    // permanent reject without inspecting the body, and we don't want
    // to leak body content into the retry log.
    throw new Error(`webhook ${responseStatus}`);
  }
  return { status: responseStatus };
}

export const __testables = { postFindingWebhook };
