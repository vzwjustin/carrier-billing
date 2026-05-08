import * as React from 'react';

import { inngest } from '../client';
import { env } from '@/env';
import {
  AuditCompletedEmail,
  type AuditCompletedEmailProps,
} from '@/lib/email/audit-completed';
import { renderAuditCompletedText } from '@/lib/email/audit-completed-text';
import { getResend } from '@/lib/resend/client';
import { FROM_ADDRESS } from '@/lib/resend/from';
import { getAdminClient } from '@/lib/supabase/admin';

/**
 * send-report-email — Phase 3 transactional email pipeline.
 *
 * Trigger: `audit.completed` event with `{ auditId, userId }`.
 *
 * Steps:
 *   1. load-context: read the audit row + the owning user's email. If the
 *      audit is not yet in `completed` state we no-op (could happen if the
 *      event was sent prematurely or after a manual rollback).
 *   2. send-email: deliver the React template + plain-text fallback through
 *      Resend. Resend errors are thrown so Inngest retries.
 *
 * PII discipline (CLAUDE.md §1#9): we never log the user's email address,
 * the bill content, or any rendered email body. Logs only contain auditId,
 * userId, and the Resend message id returned on success.
 */

const CARRIER_LABELS: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  unknown: 'wireless',
};

type LoadedContext =
  | { skipped: true }
  | {
      skipped: false;
      email: string;
      auditId: string;
      carrierLabel: string;
      billingPeriod: string;
      monthlySavingsCents: number;
      annualSavingsCents: number;
      findingCount: number;
      highSeverityCount: number;
    };

type AuditRow = {
  id: string;
  user_id: string;
  status: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
};

type AuthUserLike = {
  id?: unknown;
  email?: unknown;
};

function carrierLabelFor(carrier: string | null | undefined): string {
  if (typeof carrier !== 'string') return CARRIER_LABELS.unknown ?? 'wireless';
  return CARRIER_LABELS[carrier] ?? CARRIER_LABELS.unknown ?? 'wireless';
}

function billingPeriodLabel(
  start: string | null,
  end: string | null,
): string {
  if (start && end) return `${start} – ${end}`;
  if (start) return start;
  if (end) return end;
  return 'recent billing period';
}

export const sendReportEmailFn = inngest.createFunction(
  { id: 'send-report-email', concurrency: { limit: 10 }, retries: 2 },
  { event: 'audit.completed' },
  async ({ event, step, logger }) => {
    const { auditId, userId } = event.data;

    logger.info('sendReportEmail: start', { auditId, userId });

    // ─────────────────────────────────────────────────────────────────────
    // Step 1: load-context
    // ─────────────────────────────────────────────────────────────────────
    const ctx = (await step.run('load-context', async (): Promise<LoadedContext> => {
      const supabase = getAdminClient();

      const { data: audit, error: auditErr } = await supabase
        .from('audits')
        .select(
          'id, user_id, status, carrier, billing_period_start, billing_period_end, estimated_monthly_savings_cents, estimated_annual_savings_cents, finding_count, high_severity_count',
        )
        .eq('id', auditId)
        .maybeSingle();

      if (auditErr) {
        throw new Error(`audits select failed: ${auditErr.message}`);
      }
      if (!audit) {
        // Audit row missing — treat as a no-op rather than retrying forever.
        return { skipped: true };
      }

      const row = audit as unknown as AuditRow;
      if (row.status !== 'completed') {
        return { skipped: true };
      }

      // Fetch the owning user's email via the admin auth API.
      const { data: userResp, error: userErr } =
        await supabase.auth.admin.getUserById(row.user_id);
      if (userErr) {
        throw new Error(`auth.admin.getUserById failed: ${userErr.message}`);
      }
      const candidate: unknown = userResp?.user;
      let email: string | null = null;
      if (candidate && typeof candidate === 'object') {
        const maybe = (candidate as AuthUserLike).email;
        if (typeof maybe === 'string' && maybe.length > 0) {
          email = maybe;
        }
      }
      if (!email) {
        // No deliverable address — skip rather than retry forever.
        return { skipped: true };
      }

      return {
        skipped: false,
        email,
        auditId: row.id,
        carrierLabel: carrierLabelFor(row.carrier),
        billingPeriod: billingPeriodLabel(
          row.billing_period_start,
          row.billing_period_end,
        ),
        monthlySavingsCents: row.estimated_monthly_savings_cents ?? 0,
        annualSavingsCents: row.estimated_annual_savings_cents ?? 0,
        findingCount: row.finding_count ?? 0,
        highSeverityCount: row.high_severity_count ?? 0,
      };
    })) as LoadedContext;

    if (ctx.skipped) {
      logger.info('sendReportEmail: skipped (no completed audit or no email)', {
        auditId,
        userId,
      });
      return { skipped: true };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 2: send-email
    // ─────────────────────────────────────────────────────────────────────
    const sendResult = (await step.run('send-email', async () => {
      const reportUrl = `${env.NEXT_PUBLIC_APP_URL}/audits/${ctx.auditId}`;
      const props: AuditCompletedEmailProps = {
        auditId: ctx.auditId,
        carrierLabel: ctx.carrierLabel,
        billingPeriod: ctx.billingPeriod,
        monthlySavingsCents: ctx.monthlySavingsCents,
        annualSavingsCents: ctx.annualSavingsCents,
        findingCount: ctx.findingCount,
        highSeverityCount: ctx.highSeverityCount,
        reportUrl,
      };

      const resend = getResend();
      const response = await resend.emails.send({
        from: FROM_ADDRESS,
        to: ctx.email,
        subject: 'Your CarrierAudit report is ready',
        react: React.createElement(AuditCompletedEmail, props),
        text: renderAuditCompletedText(props),
      });

      if (response.error) {
        // Throw so Inngest retries (up to the function's retry limit).
        throw new Error(
          `resend send failed: ${response.error.name}: ${response.error.message}`,
        );
      }
      const messageId =
        response.data && typeof response.data.id === 'string'
          ? response.data.id
          : null;
      return { messageId };
    })) as { messageId: string | null };

    logger.info('sendReportEmail: sent', {
      auditId,
      userId,
      resendMessageId: sendResult.messageId,
    });

    return { sent: true, resendMessageId: sendResult.messageId };
  },
);
