/**
 * Server-rendered HTML body for the monthly bill-upload reminder.
 *
 * Dispatched by the `send-bill-upload-reminders` cron for users who have not
 * completed an audit in the last 30 days. Informational; the CTA links to the
 * in-app upload page.
 */
import * as React from 'react';

export type BillReminderEmailProps = {
  uploadUrl: string;
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

export function BillReminderEmail(props: BillReminderEmailProps): React.ReactElement {
  const { uploadUrl } = props;

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
  };
  const bodyStyle: React.CSSProperties = {
    fontSize: '14px',
    color: COLORS.muted,
    margin: '0 0 20px 0',
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
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h1 style={headingStyle}>Time for this month&apos;s bill audit</h1>
        <p style={bodyStyle}>
          New month, new wireless bill. Upload your latest statement and we&apos;ll re-check it for
          overcharges, expired promos, and plan mismatches — usually in under five minutes.
        </p>
        <a href={uploadUrl} style={ctaStyle}>
          Upload this month&apos;s bill
        </a>
        <div style={footerStyle}>
          <p style={{ margin: '0 0 8px 0' }}>
            Don&apos;t want these reminders? Manage notifications in your settings.
          </p>
          <p style={{ margin: 0 }}>CarrierAudit</p>
        </div>
      </div>
    </div>
  );
}

export default BillReminderEmail;
