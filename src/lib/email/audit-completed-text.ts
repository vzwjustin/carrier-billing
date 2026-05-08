import { formatCents } from '@/lib/utils';

import type { AuditCompletedEmailProps } from './audit-completed';

/**
 * Plain-text fallback for the audit-completed email. Sent alongside the
 * HTML/React body via Resend's `text:` field for clients that don't render
 * HTML and for accessibility.
 */
export function renderAuditCompletedText(
  props: AuditCompletedEmailProps,
): string {
  const {
    carrierLabel,
    billingPeriod,
    monthlySavingsCents,
    annualSavingsCents,
    findingCount,
    highSeverityCount,
    reportUrl,
  } = props;

  const lines: string[] = [
    'Your CarrierAudit report is ready',
    '',
    `We found ${formatCents(annualSavingsCents)} of potential annual savings on your ${carrierLabel} bill.`,
    '',
    "Inside the report you'll find a prioritized list of findings, recommended actions for each, and the evidence we used so you can take them straight to your carrier rep.",
    '',
    `Billing period: ${billingPeriod}`,
    `Findings: ${findingCount} (${highSeverityCount} high-severity)`,
    `Estimated monthly savings: ${formatCents(monthlySavingsCents)}/mo`,
    `Estimated annual savings: ${formatCents(annualSavingsCents)}/year`,
    '',
    `View report: ${reportUrl}`,
    '',
    "If you didn't request this, you can ignore this email.",
    'CarrierAudit · unsubscribe: mailto:hello@carrieraudit.com?subject=Unsubscribe',
  ];

  return lines.join('\n');
}
