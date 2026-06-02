/**
 * Server-rendered HTML email body for audit-completed notification.
 *
 * No 'use client' — Resend renders the React tree to HTML on the server when
 * passed via the `react:` option. We use only inline styles + system fonts so
 * the result survives the various email clients (Gmail, Outlook, Apple Mail).
 */
import * as React from 'react';

import { formatCents } from '@/lib/utils';

export type AuditCompletedEmailProps = {
  auditId: string;
  carrierLabel: string;
  billingPeriod: string;
  monthlySavingsCents: number;
  annualSavingsCents: number;
  findingCount: number;
  highSeverityCount: number;
  reportUrl: string;
};

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Helvetica, Arial, sans-serif';

const COLORS = {
  text: '#0f172a',
  muted: '#475569',
  border: '#e2e8f0',
  accent: '#0f766e',
  bg: '#f8fafc',
  white: '#ffffff',
} as const;

export function AuditCompletedEmail(props: AuditCompletedEmailProps): React.ReactElement {
  const {
    carrierLabel,
    billingPeriod,
    monthlySavingsCents,
    annualSavingsCents,
    findingCount,
    highSeverityCount,
    reportUrl,
  } = props;

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
  const heroStyle: React.CSSProperties = {
    fontSize: '16px',
    color: COLORS.text,
    margin: '0 0 16px 0',
  };
  const heroAmountStyle: React.CSSProperties = {
    color: COLORS.accent,
    fontWeight: 700,
  };
  const bodyStyle: React.CSSProperties = {
    fontSize: '14px',
    color: COLORS.muted,
    margin: '0 0 20px 0',
  };
  const statListStyle: React.CSSProperties = {
    listStyle: 'none',
    padding: 0,
    margin: '0 0 24px 0',
    fontSize: '14px',
    color: COLORS.text,
  };
  const statItemStyle: React.CSSProperties = {
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
  const footerLinkStyle: React.CSSProperties = {
    color: COLORS.muted,
    textDecoration: 'underline',
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h1 style={headingStyle}>Your CarrierAudit report is ready</h1>

        <p style={heroStyle}>
          We found <span style={heroAmountStyle}>{formatCents(annualSavingsCents)}</span> of
          potential annual savings on your {carrierLabel} bill.
        </p>

        <p style={bodyStyle}>
          Inside the report you&apos;ll find a prioritized list of findings, recommended actions for
          each, and the evidence we used so you can take them straight to your carrier rep.
        </p>

        <ul style={statListStyle}>
          <li style={statItemStyle}>
            Billing period: <strong>{billingPeriod}</strong>
          </li>
          <li style={statItemStyle}>
            Findings: <strong>{findingCount}</strong> ({highSeverityCount} high-severity)
          </li>
          <li style={statItemStyle}>
            Estimated monthly savings: <strong>{formatCents(monthlySavingsCents)}/mo</strong>
          </li>
          <li style={statItemStyle}>
            Estimated annual savings: <strong>{formatCents(annualSavingsCents)}/year</strong>
          </li>
        </ul>

        <a href={reportUrl} style={ctaStyle}>
          View report
        </a>

        <div style={footerStyle}>
          <p style={{ margin: '0 0 8px 0' }}>
            If you didn&apos;t request this, you can ignore this email.
          </p>
          <p style={{ margin: 0 }}>
            CarrierAudit ·{' '}
            <a href="mailto:hello@carrieraudit.com?subject=Unsubscribe" style={footerLinkStyle}>
              unsubscribe
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default AuditCompletedEmail;
