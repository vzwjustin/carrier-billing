import { createHmac } from 'node:crypto';

import { inngest } from '../client';
import { AuditCompletedDataSchema, parseEventData } from '../events';
import { assertPublicHttpsTarget } from '@/lib/security/ssrf-guard';
import { getAdminClient } from '@/lib/supabase/admin';
import type {
  AuditCarrier,
  AuditStatus,
  FindingSeverity,
} from '@/types/db-enums';

/**
 * dispatch-outbound-webhook — POST a completed audit's report to the user's
 * configured outbound webhook URL, signed with HMAC-SHA256 of the body.
 *
 * Trigger: `audit.completed`. Concurrency limit + retries are conservative
 * because we hit a third-party URL — slow or flaky receivers shouldn't pile
 * up parallel deliveries.
 *
 * Skipped silently if the user has no `outbound_webhook_url` configured.
 *
 * Signature contract — v2 (timestamped, Stripe-style; documented in
 * `src/components/settings/outbound-webhook-card.tsx`):
 *   X-CarrierAudit-Timestamp: <unix-seconds>
 *   X-CarrierAudit-Signature: t=<unix-seconds>,v1=hex(hmac_sha256(`${t}.${body}`, secret))
 *   X-CarrierAudit-Event: audit.completed
 *   X-CarrierAudit-Audit-Id: <auditId>
 *
 * v2 signature scheme; receivers should reject timestamps older than 5 min to
 * prevent replay.
 */

interface ProfileRow {
  id: string;
  outbound_webhook_url: string | null;
  outbound_webhook_secret: string | null;
}

interface AuditRow {
  id: string;
  user_id: string;
  // M13: literal union mirrored from supabase/migrations/0005 CHECK.
  status: AuditStatus;
  carrier: AuditCarrier | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
  completed_at: string | null;
}

interface FindingRow {
  id: string;
  rule_id: string;
  // M13: literal union mirrored from supabase/migrations/0005 CHECK.
  severity: FindingSeverity;
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number | null;
  confidence: number | null;
}

export const dispatchOutboundWebhookFn = inngest.createFunction(
  {
    id: 'dispatch-outbound-webhook',
    concurrency: { limit: 5 },
    retries: 3,
  },
  { event: 'audit.completed' },
  async ({ event, step, logger }) => {
    // M11: validate the payload at the boundary.
    const { auditId, userId } = parseEventData(
      'audit.completed',
      event.data,
      AuditCompletedDataSchema,
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

      const { data: audit, error: auditErr } = await admin
        .from('audits')
        .select(
          'id, user_id, status, carrier, billing_period_start, billing_period_end, estimated_monthly_savings_cents, estimated_annual_savings_cents, finding_count, high_severity_count, completed_at',
        )
        .eq('id', auditId)
        .maybeSingle();
      if (auditErr) {
        throw new Error(`audit read failed: ${auditErr.message}`);
      }
      const a = (audit ?? null) as AuditRow | null;
      if (!a || a.status !== 'completed') {
        return { skipped: true as const, reason: 'not_completed' };
      }

      const { data: findings, error: findingsErr } = await admin
        .from('findings')
        .select(
          'id, rule_id, severity, title, description, recommended_action, estimated_monthly_savings_cents, confidence',
        )
        .eq('audit_id', auditId);
      if (findingsErr) {
        throw new Error(`findings read failed: ${findingsErr.message}`);
      }

      return {
        skipped: false as const,
        url: p.outbound_webhook_url,
        secret: p.outbound_webhook_secret,
        audit: a,
        findings: (findings ?? []) as FindingRow[],
      };
    })) as
      | { skipped: true; reason: string }
      | {
          skipped: false;
          url: string;
          secret: string;
          audit: AuditRow;
          findings: FindingRow[];
        };

    if (ctx.skipped) {
      logger.info('dispatchOutboundWebhook: skipped', {
        auditId,
        userId,
        reason: ctx.reason,
      });
      return { skipped: true, reason: ctx.reason };
    }

    const result = (await step.run('post-webhook', async () => {
      return postOutboundWebhook({
        url: ctx.url,
        secret: ctx.secret,
        audit: ctx.audit,
        findings: ctx.findings,
      });
    })) as { status: number };

    logger.info('dispatchOutboundWebhook: delivered', {
      auditId,
      userId,
      status: result.status,
    });
    return { delivered: true, status: result.status };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Extracted POST logic — kept as a separate function so unit tests can
// exercise the signing + fetch + SSRF-guard path without spinning up an
// Inngest runtime. Exported via `__testables` (test-only surface).
// ─────────────────────────────────────────────────────────────────────────────

interface PostOutboundWebhookInput {
  url: string;
  secret: string;
  audit: AuditRow;
  findings: FindingRow[];
}

async function postOutboundWebhook(
  input: PostOutboundWebhookInput,
): Promise<{ status: number }> {
  const { url, secret, audit, findings } = input;

  const payload = {
    event: 'audit.completed' as const,
    delivered_at: new Date().toISOString(),
    audit: {
      id: audit.id,
      user_id: audit.user_id,
      status: audit.status,
      carrier: audit.carrier,
      billing_period_start: audit.billing_period_start,
      billing_period_end: audit.billing_period_end,
      estimated_monthly_savings_cents:
        audit.estimated_monthly_savings_cents ?? 0,
      estimated_annual_savings_cents:
        audit.estimated_annual_savings_cents ?? 0,
      finding_count: audit.finding_count ?? 0,
      high_severity_count: audit.high_severity_count ?? 0,
      completed_at: audit.completed_at,
    },
    findings: findings.map((f) => ({
      id: f.id,
      rule_id: f.rule_id,
      severity: f.severity,
      title: f.title,
      description: f.description,
      recommended_action: f.recommended_action,
      estimated_monthly_savings_cents: f.estimated_monthly_savings_cents ?? 0,
      confidence: f.confidence,
    })),
  };

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  // v2 signature: HMAC over `${timestamp}.${body}` so a captured request
  // can't be replayed indefinitely. Receivers should reject timestamps older
  // than 5 min.
  const signedPayload = `${timestamp}.${body}`;
  const sigHex = createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
  const signatureHeader = `t=${timestamp},v1=${sigHex}`;

  // Re-validate the URL at dispatch time — checking only at submit-time
  // would let an attacker register a public DNS name now and rebind it to
  // 127.0.0.1 / 169.254.169.254 before the worker fires. Resolve fresh
  // here, then `fetch` the literal IP with the original Host header
  // preserved so TLS/SNI still terminates correctly.
  const target = await assertPublicHttpsTarget(url);

  const original = new URL(url);
  const host =
    original.port.length > 0
      ? `${original.hostname}:${original.port}`
      : original.hostname;
  // Wrap IPv6 literal in brackets for URL syntax.
  const ipForUrl =
    target.family === 6 ? `[${target.resolvedIp}]` : target.resolvedIp;
  const portSuffix = original.port.length > 0 ? `:${original.port}` : '';
  const pinnedUrl = `https://${ipForUrl}${portSuffix}${original.pathname}${original.search}`;

  // Bound the round-trip so a slow consumer doesn't park a worker.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(pinnedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: host,
        'X-CarrierAudit-Timestamp': String(timestamp),
        'X-CarrierAudit-Signature': signatureHeader,
        'X-CarrierAudit-Event': 'audit.completed',
        'X-CarrierAudit-Audit-Id': audit.id,
        'User-Agent': 'CarrierAudit-Webhook/1.0',
      },
      body,
      signal: controller.signal,
      // No redirects — receivers should expose a stable URL, and silently
      // following a 30x to a different host opens a small SSRF surface.
      redirect: 'error',
    });

    if (!response.ok) {
      // Throw so Inngest retries; only surface the status code, not the
      // body, to keep PII out of logs.
      throw new Error(`webhook ${response.status}`);
    }
    return { status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

export const __testables = { postOutboundWebhook };
