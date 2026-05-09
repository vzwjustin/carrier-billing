import * as React from 'react';

import { inngest } from '../client';
import { env } from '@/env';
import {
  PaymentFailedEmail,
  type PaymentFailedEmailProps,
} from '@/lib/email/payment-failed';
import { renderPaymentFailedText } from '@/lib/email/payment-failed-text';
import { getResend } from '@/lib/resend/client';
import { FROM_ADDRESS } from '@/lib/resend/from';
import { getAdminClient } from '@/lib/supabase/admin';

/**
 * send-payment-failed-email — notify the user that their Stripe invoice
 * failed and their subscription is past_due.
 *
 * Trigger: `billing.payment_failed` event emitted from
 * `src/lib/stripe/handlers.ts:onInvoicePaymentFailed` after the profile is
 * flipped to past_due.
 *
 * The CTA links to the in-app recovery page (`/billing/past-due`) rather
 * than directly to a Stripe billing portal session — portal URLs expire and
 * email may be opened later. The recovery page mints a fresh portal session.
 *
 * Stripe's smart-retry can deliver `invoice.payment_failed` multiple times
 * for the same invoice. The email is informational and acceptable to resend;
 * if dedup becomes a problem, key on `invoiceId` in `billing_events` later.
 *
 * PII discipline (CLAUDE.md §1#9): we never log the recipient address. Logs
 * carry only userId, the resend message id, and (intentionally) the truncated
 * Stripe invoice id which is operator-scoped.
 */

type LoadedContext =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      email: string;
    };

type ProfileRow = {
  id: string;
  email: string | null;
  subscription_status: string | null;
};

export const sendPaymentFailedEmailFn = inngest.createFunction(
  {
    id: 'send-payment-failed-email',
    concurrency: { limit: 10 },
    retries: 2,
  },
  { event: 'billing.payment_failed' },
  async ({ event, step, logger }) => {
    const { userId, invoiceId, amountDueCents } = event.data;

    logger.info('sendPaymentFailedEmail: start', { userId, invoiceId });

    const ctx = (await step.run(
      'load-context',
      async (): Promise<LoadedContext> => {
        const supabase = getAdminClient();
        const { data, error } = await supabase
          .from('profiles')
          .select('id, email, subscription_status')
          .eq('id', userId)
          .maybeSingle();

        if (error) {
          throw new Error(`profiles select failed: ${error.message}`);
        }
        if (!data) {
          return { skipped: true, reason: 'profile-missing' };
        }

        const row = data as unknown as ProfileRow;
        if (row.subscription_status !== 'past_due') {
          return { skipped: true, reason: 'status-recovered' };
        }
        if (!row.email) {
          return { skipped: true, reason: 'no-email' };
        }

        return { skipped: false, email: row.email };
      },
    )) as LoadedContext;

    if (ctx.skipped) {
      logger.info('sendPaymentFailedEmail: skipped', {
        userId,
        invoiceId,
        reason: ctx.reason,
      });
      return { skipped: true, reason: ctx.reason };
    }

    const sendResult = (await step.run('send-email', async () => {
      const recoveryUrl = `${env.NEXT_PUBLIC_APP_URL}/billing/past-due`;
      const props: PaymentFailedEmailProps = {
        customerEmail: ctx.email,
        recoveryUrl,
        amountDueCents,
        invoiceId,
      };

      const resend = getResend();
      const response = await resend.emails.send({
        from: FROM_ADDRESS,
        to: ctx.email,
        subject: 'Action needed: your CarrierAudit payment failed',
        react: React.createElement(PaymentFailedEmail, props),
        text: renderPaymentFailedText(props),
      });

      if (response.error) {
        const code =
          typeof (response.error as { name?: unknown }).name === 'string'
            ? (response.error as { name: string }).name
            : 'unknown';
        throw new Error(`resend send failed: ${code}`);
      }
      const messageId =
        response.data && typeof response.data.id === 'string'
          ? response.data.id
          : null;
      return { messageId };
    })) as { messageId: string | null };

    logger.info('sendPaymentFailedEmail: sent', {
      userId,
      invoiceId,
      resendMessageId: sendResult.messageId,
    });

    return { sent: true, resendMessageId: sendResult.messageId };
  },
);
