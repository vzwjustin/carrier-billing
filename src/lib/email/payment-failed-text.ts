import { formatCents } from '@/lib/utils';

import type { PaymentFailedEmailProps } from './payment-failed';

/**
 * Plain-text fallback for the payment-failed email. Sent alongside the
 * HTML/React body via Resend's `text:` field.
 */
export function renderPaymentFailedText(props: PaymentFailedEmailProps): string {
  const { recoveryUrl, amountDueCents, invoiceId } = props;
  const tail = invoiceId && invoiceId.length >= 6 ? invoiceId.slice(-6) : invoiceId;

  const lines: string[] = [
    'Your CarrierAudit payment failed',
    '',
    "We weren't able to charge your card. Your subscription is now past due.",
    '',
    'To keep running audits, please update your payment method. Once a successful charge is processed your subscription will reactivate automatically.',
    '',
  ];

  if (amountDueCents !== null && amountDueCents > 0) {
    lines.push(`Amount due: ${formatCents(amountDueCents)}`);
  }
  if (tail) {
    lines.push(`Invoice reference: …${tail}`);
  }
  lines.push('', `Update payment method: ${recoveryUrl}`, '');
  lines.push("Need help? Reply to this email and we'll get back to you.");
  lines.push('CarrierAudit');

  return lines.join('\n');
}
