/**
 * Pure builder for the plain-text dispute email draft (`dispute.eml`).
 *
 * Returns RFC 822-shaped headers + body suitable for the operator to paste
 * into their email client of choice. The route serves this as
 * `Content-Type: message/rfc822` so most desktop clients open it directly.
 *
 * No I/O — feeds entirely off the already-built `DisputePacket`. Same PII
 * discipline as `builder.ts`: masked MDNs only, no employee names, no raw
 * bill text.
 */
import type { DisputePacket } from './builder';

export interface DisputeEmailDraft {
  subject: string;
  body: string;
}

const SUBJECT_PREFIX = 'Billing dispute';

function renderAffectedLines(packet: DisputePacket): string {
  if (packet.affectedLines.length === 0) {
    return '  (none specified)';
  }
  return packet.affectedLines
    .map((l) => `  - ${l.mdnDisplay}  ·  ${l.planDisplay}`)
    .join('\n');
}

function renderAccounts(packet: DisputePacket): string {
  if (packet.accounts.length === 0) return '(account not specified)';
  return packet.accounts
    .map((a) => {
      if (a.label && a.numberDisplay !== '—') {
        return `${a.label} (${a.numberDisplay})`;
      }
      if (a.label) return a.label;
      return a.numberDisplay;
    })
    .join(', ');
}

/**
 * Render the full plain-text body of the email. We keep the body
 * single-paragraph + bulleted-list style so it reads cleanly in both
 * plain-text and HTML-rendered mail clients without any HTML markup.
 */
function renderBody(packet: DisputePacket): string {
  const accountsLine = renderAccounts(packet);
  const lines: string[] = [
    `Hello,`,
    ``,
    `I'm writing to dispute a charge on my ${packet.carrierName} bill for the period ${packet.billingPeriodDisplay} (account: ${accountsLine}).`,
    ``,
    `Issue: ${packet.findingTitle}`,
    `Severity: ${packet.severityLabel}`,
    `Requested credit: ${packet.requestedCreditDisplay}`,
    `Estimated annual impact if uncorrected: ${formatCentsForEmail(packet.requestedCreditAnnualCents)}`,
    ``,
    `Explanation:`,
    packet.description,
    ``,
    `Requested action:`,
    packet.recommendedAction,
    ``,
    `Affected lines:`,
    renderAffectedLines(packet),
    ``,
    `Please open a billing adjustment ticket, confirm the credit going forward, and send written confirmation with the ticket number for my records.`,
    ``,
    `Reference: CarrierAudit packet ${packet.auditShortId} · rule ${packet.ruleId} · generated ${packet.generatedDateDisplay}`,
    ``,
    `Thank you.`,
  ];
  return lines.join('\n');
}

function formatCentsForEmail(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

export function buildDisputeEmail(packet: DisputePacket): DisputeEmailDraft {
  const subject = `${SUBJECT_PREFIX}: ${packet.findingTitle} (${packet.carrierName} · ${packet.billingPeriodDisplay})`;
  return {
    subject,
    body: renderBody(packet),
  };
}

/**
 * Render a packet as a minimal RFC 822 message (subject header + plain-text
 * body) suitable for saving as a `.eml` file. We deliberately do not include
 * From / To / Date headers — the operator's mail client populates those when
 * the draft is opened.
 */
export function buildDisputeEml(packet: DisputePacket): string {
  const { subject, body } = buildDisputeEmail(packet);
  // CRLF line endings per RFC 5322 §2.1. Subject line is the only header we
  // emit; everything after the blank line is the plain-text body.
  const header = [
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    `X-CarrierAudit-Packet: ${packet.auditShortId}/${packet.ruleId}`,
  ].join('\r\n');
  return `${header}\r\n\r\n${body.replace(/\n/g, '\r\n')}\r\n`;
}
