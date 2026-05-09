/**
 * Server-rendered HTML email body for payment-failed notification.
 *
 * Sent when Stripe reports an `invoice.payment_failed` and the user's
 * subscription has been flipped to `past_due`. The CTA links into the in-app
 * recovery page (`/billing/past-due`) rather than directly to a Stripe portal
 * URL — portal sessions expire and the user may open the email later.
 */
import * as React from 'react';

import { formatCents } from '@/lib/utils';

export type PaymentFailedEmailProps = {
  customerEmail: string;
  recoveryUrl: string;
  amountDueCents: number | null;
  invoiceId: string | null;
};

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Helvetica, Arial, sans-serif';

const COLORS = {
  text: '#0f172a',
  muted: '#475569',
  border: '#e2e8f0',
  warning: '#b45309',
  warningBg: '#fffbeb',
  warningBorder: '#fde68a',
  accent: '#0f766e',
  bg: '#f8fafc',
  white: '#ffffff',
} as const;

function invoiceTail(invoiceId: string | null): string | null {
  if (!invoiceId || invoiceId.length < 6) return invoiceId;
  return invoiceId.slice(-6);
}

export function PaymentFailedEmail(
  props: PaymentFailedEmailProps,
): React.ReactElement {
  const { recoveryUrl, amountDueCents, invoiceId } = props;
  const tail = invoiceTail(invoiceId);

  const containerStyle: React.CSSProperties = {
    backgroundColor: COLORS.bg,
    fontFamily: FONT_STACK,
    padding: '24px',
    margin: 0,
  };
  const cardStyle: React.CSSProperties = {
    backgroundColor: COLORS.white,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '12px',
    padding: '32px',
    maxWidth: '560px',
    margin: '0 auto',
    color: COLORS.text,
    lineHeight: 1.5,
  };
  const headingStyle: React.CSSProperties = {
    fontSize: '22px',
    fontWeight: 700,
    margin: '0 0 16px 0',
    color: COLORS.text,
  };
  const calloutStyle: React.CSSProperties = {
    backgroundColor: COLORS.warningBg,
    border: `1px solid ${COLORS.warningBorder}`,
    borderRadius: '8px',
    padding: '14px 16px',
    margin: '0 0 20px 0',
    color: COLORS.warning,
    fontSize: '14px',
    fontWeight: 500,
  };
  const bodyStyle: React.CSSProperties = {
    fontSize: '14px',
    color: COLORS.muted,
    margin: '0 0 16px 0',
  };
  const detailListStyle: React.CSSProperties = {
    listStyle: 'none',
    padding: 0,
    margin: '0 0 24px 0',
    fontSize: '14px',
    color: COLORS.text,
  };
  const detailItemStyle: React.CSSProperties = {
    padding: '8px 0',
    borderBottom: `1px solid ${COLORS.border}`,
  };
  const ctaStyle: React.CSSProperties = {
    display: 'inline-block',
    backgroundColor: COLORS.accent,
    color: COLORS.white,
    textDecoration: 'none',
    padding: '12px 20px',
    borderRadius: '8px',
    fontWeight: 600,
    fontSize: '14px',
  };
  const footerStyle: React.CSSProperties = {
    marginTop: '32px',
    fontSize: '12px',
    color: COLORS.muted,
    lineHeight: 1.5,
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h1 style={headingStyle}>Your CarrierAudit payment failed</h1>

        <div style={calloutStyle}>
          We weren&apos;t able to charge your card. Your subscription is now
          past due.
        </div>

        <p style={bodyStyle}>
          To keep running audits, please update your payment method. Once a
          successful charge is processed your subscription will reactivate
          automatically.
        </p>

        <ul style={detailListStyle}>
          {amountDueCents !== null && amountDueCents > 0 ? (
            <li style={detailItemStyle}>
              Amount due: <strong>{formatCents(amountDueCents)}</strong>
            </li>
          ) : null}
          {tail ? (
            <li style={detailItemStyle}>
              Invoice reference: <strong>…{tail}</strong>
            </li>
          ) : null}
        </ul>

        <a href={recoveryUrl} style={ctaStyle}>
          Update payment method
        </a>

        <div style={footerStyle}>
          <p style={{ margin: '0 0 8px 0' }}>
            Need help? Reply to this email and we&apos;ll get back to you.
          </p>
          <p style={{ margin: 0 }}>CarrierAudit</p>
        </div>
      </div>
    </div>
  );
}

export default PaymentFailedEmail;
