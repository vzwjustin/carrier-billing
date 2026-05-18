import * as React from 'react';

import { inngest } from '../client';
import { env } from '@/env';
import {
  BillReminderEmail,
  type BillReminderEmailProps,
} from '@/lib/email/bill-reminder';
import { renderBillReminderText } from '@/lib/email/bill-reminder-text';
import { getResend } from '@/lib/resend/client';
import { FROM_ADDRESS } from '@/lib/resend/from';
import { getAdminClient } from '@/lib/supabase/admin';

/**
 * send-bill-upload-reminders — monthly nudge for users who haven't completed
 * an audit recently.
 *
 * SAFETY GATE: emails are only sent when `BILL_REMINDER_ENABLED === 'true'`.
 * Until a verified Resend sender domain is configured (FROM_ADDRESS is a
 * TODO(domain)), the job runs in dry-run mode — it selects the due cohort and
 * logs the count but sends nothing. This prevents accidental mass mail /
 * bounce damage from an unverified domain.
 *
 * PII discipline (CLAUDE.md §1#9): logs only counts and userIds, never email
 * addresses.
 */

const INACTIVITY_DAYS = 30;
const MAX_RECIPIENTS = 1000;

type ProfileRow = { id: string; email: string | null };
type AuditUserRow = { user_id: string };

export const sendBillUploadRemindersFn = inngest.createFunction(
  { id: 'send-bill-upload-reminders', retries: 1 },
  { cron: '0 15 1 * *' },
  async ({ step, logger }) => {
    const due = (await step.run('select-due-users', async () => {
      const supabase = getAdminClient();
      const cutoff = new Date(
        Date.now() - INACTIVITY_DAYS * 24 * 60 * 60_000,
      ).toISOString();

      const { data: recentData, error: recentErr } = await supabase
        .from('audits')
        .select('user_id')
        .eq('status', 'completed')
        .gte('created_at', cutoff);
      if (recentErr) {
        throw new Error(`audits select failed: ${recentErr.message}`);
      }
      const active = new Set(
        ((recentData ?? []) as AuditUserRow[]).map((r) => r.user_id),
      );

      const { data: profileData, error: profileErr } = await supabase
        .from('profiles')
        .select('id, email')
        .limit(MAX_RECIPIENTS);
      if (profileErr) {
        throw new Error(`profiles select failed: ${profileErr.message}`);
      }

      return ((profileData ?? []) as ProfileRow[])
        .filter((p) => !active.has(p.id) && !!p.email)
        .map((p) => ({ id: p.id, email: p.email as string }));
    })) as { id: string; email: string }[];

    const enabled = env.BILL_REMINDER_ENABLED === 'true';
    logger.info('sendBillUploadReminders: cohort selected', {
      dueCount: due.length,
      enabled,
    });

    if (!enabled) {
      // Dry-run: do not send. The cohort size is the useful signal.
      return { dryRun: true, dueCount: due.length, sent: 0 };
    }

    const uploadUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/audits/new`;
    let sent = 0;

    for (const user of due) {
      await step.run(`send-${user.id}`, async () => {
        const props: BillReminderEmailProps = { uploadUrl };
        const resend = getResend();
        const response = await resend.emails.send({
          from: FROM_ADDRESS,
          to: user.email,
          subject: 'Time for this month’s CarrierAudit bill check',
          react: React.createElement(BillReminderEmail, props),
          text: renderBillReminderText(props),
        });
        if (response.error) {
          const code =
            typeof (response.error as { name?: unknown }).name === 'string'
              ? (response.error as { name: string }).name
              : 'unknown';
          throw new Error(`resend send failed: ${code}`);
        }
        return { ok: true };
      });
      sent += 1;
    }

    logger.info('sendBillUploadReminders: done', { sent });
    return { dryRun: false, dueCount: due.length, sent };
  },
);
