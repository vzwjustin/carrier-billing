/**
 * Monthly audit digest — pure email builder.
 *
 * Returns `{ subject, text, html }` for a single recipient. The function is
 * intentionally I/O-free: callers (the Inngest cron in
 * `src/inngest/functions/send-monthly-digest.ts`, plus the unit tests) feed
 * pre-aggregated values in and the builder shapes them into a deliverable
 * email body.
 *
 * Rendering notes:
 *   - Plain HTML strings (inline styles, no template library) — feature pass
 *     allowance per the spec. Keeps the bundle small and matches how Resend
 *     ingests `html:`.
 *   - Every interpolated value goes through `escapeHtml` before landing in the
 *     HTML body. The plain-text body uses the raw values (text/plain mail
 *     parts are not HTML-interpreted).
 *
 * PII discipline (CLAUDE.md §1#9):
 *   - `mdnMaskedLast4` is the LAST-4 digits of an MDN; callers must strip /
 *     mask any longer form before it reaches this module. The builder
 *     additionally clamps the value to 4 chars in case a caller misses.
 *   - No employee names, no full account numbers — `label` is the line's
 *     `user_label` (the customer-supplied or carrier-supplied display name)
 *     and is HTML-escaped before rendering.
 */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function formatCents(cents: number): string {
  return USD.format(cents / 100);
}

/**
 * Signed cents formatter for the autopsy net-change line. Negative values are
 * rendered as `-$12.34`, positive as `+$12.34`, zero as `$0.00` (no sign).
 */
export function formatSignedCents(cents: number): string {
  if (cents === 0) return USD.format(0);
  const sign = cents > 0 ? '+' : '-';
  return `${sign}${USD.format(Math.abs(cents) / 100)}`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Truncate to the last 4 chars + redact any leading digits to avoid leaking
 * a full MDN if a caller forgets to mask. Inputs that are already last-4 are
 * returned as-is (after stripping non-digits).
 */
export function clampLast4(masked: string | null | undefined): string {
  if (typeof masked !== 'string') return '••••';
  const digits = masked.replace(/\D/g, '');
  if (digits.length === 0) return '••••';
  return digits.slice(-4).padStart(4, '•');
}

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface DigestTopLine {
  /** Line's `user_label`, e.g. "John's iPhone" or a carrier-provided label. */
  label: string | null;
  /** Last-4 of the MDN (already-masked input). */
  mdnMaskedLast4: string | null;
  /** Rule id that flagged this line — used to bucket waste in the copy. */
  ruleId: string;
  /** Estimated monthly savings recoverable on this line, in cents. */
  estimatedMonthlySavingsCents: number;
}

export interface DigestOpenFindingsBySeverity {
  high: number;
  medium: number;
  low: number;
}

export interface DigestAutopsy {
  /** Net change between the two compared audits, signed cents. */
  netChangeCents: number;
  /** Portion of the change classified as disputable (signed cents). */
  disputableCents: number;
  /** Portion of the change addressable by optimization (signed cents). */
  optimizationCents: number;
}

export interface MonthlyDigestProps {
  /** "May 2026" — the month the digest covers. */
  periodLabel: string;
  /** Total spend across recent completed audits, in cents. */
  totalSpendCents: number;
  /** Autopsy summary if a recent comparison exists; null otherwise. */
  autopsy: DigestAutopsy | null;
  /** Counts of findings in status IN ('new','in_review','approved') by severity. */
  openFindingsBySeverity: DigestOpenFindingsBySeverity;
  /** Sum of estimated_monthly_savings_cents across the same open-finding set. */
  totalRecoverableSavingsCents: number;
  /** Up to 3 lines, ranked by estimated monthly waste. */
  topUnusedLines: DigestTopLine[];
  /** Public dashboard URL for the user (already trimmed of trailing slashes). */
  dashboardUrl: string;
  /** Public unsubscribe URL — opens the GET handler that flips opt-out. */
  unsubscribeUrl: string;
}

export interface MonthlyDigestRendered {
  subject: string;
  text: string;
  html: string;
}

// ---------------------------------------------------------------------------
// Rule → label
// ---------------------------------------------------------------------------

const RULE_LABEL: Record<string, string> = {
  zero_usage_phone_line: 'Zero usage',
  suspended_line_billed: 'Suspended but billed',
  unused_mifi_or_jetpack_line: 'Unused hotspot',
};

function ruleLabel(ruleId: string): string {
  return RULE_LABEL[ruleId] ?? 'Unused';
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

function buildSubject(props: MonthlyDigestProps): string {
  const savings = formatCents(props.totalRecoverableSavingsCents);
  return `Your ${props.periodLabel} CarrierAudit digest — ${savings} recoverable`;
}

// ---------------------------------------------------------------------------
// Plain-text body
// ---------------------------------------------------------------------------

function lineSummary(line: DigestTopLine): string {
  const last4 = clampLast4(line.mdnMaskedLast4);
  const label = line.label && line.label.length > 0 ? line.label : 'Line';
  const tag = ruleLabel(line.ruleId);
  return `  • ${label} (…${last4}) — ${tag}: ${formatCents(line.estimatedMonthlySavingsCents)}/mo`;
}

export function renderMonthlyDigestText(props: MonthlyDigestProps): string {
  const {
    periodLabel,
    totalSpendCents,
    autopsy,
    openFindingsBySeverity,
    totalRecoverableSavingsCents,
    topUnusedLines,
    dashboardUrl,
    unsubscribeUrl,
  } = props;

  const lines: string[] = [
    `CarrierAudit — ${periodLabel} digest`,
    '',
    `Total spend across recent bills: ${formatCents(totalSpendCents)}`,
  ];

  if (autopsy) {
    lines.push(
      `Month-over-month change: ${formatSignedCents(autopsy.netChangeCents)}`,
      `  Disputable: ${formatCents(autopsy.disputableCents)}`,
      `  Optimization: ${formatCents(autopsy.optimizationCents)}`,
    );
  } else {
    lines.push('Month-over-month change: not enough history yet');
  }

  lines.push(
    '',
    `Open findings: ${openFindingsBySeverity.high} high · ${openFindingsBySeverity.medium} medium · ${openFindingsBySeverity.low} low`,
    `Total recoverable savings: ${formatCents(totalRecoverableSavingsCents)}/mo`,
    '',
  );

  if (topUnusedLines.length > 0) {
    lines.push('Top unused lines:');
    for (const line of topUnusedLines.slice(0, 3)) {
      lines.push(lineSummary(line));
    }
    lines.push('');
  }

  lines.push(
    `View your dashboard: ${dashboardUrl}`,
    '',
    'You receive this digest once a month while you have active findings.',
    `Unsubscribe: ${unsubscribeUrl}`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTML body
// ---------------------------------------------------------------------------

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Helvetica, Arial, sans-serif';

function buildHtml(props: MonthlyDigestProps): string {
  const {
    periodLabel,
    totalSpendCents,
    autopsy,
    openFindingsBySeverity,
    totalRecoverableSavingsCents,
    topUnusedLines,
    dashboardUrl,
    unsubscribeUrl,
  } = props;

  const safePeriod = escapeHtml(periodLabel);
  const safeDashboard = escapeHtml(dashboardUrl);
  const safeUnsub = escapeHtml(unsubscribeUrl);

  const autopsyBlock = autopsy
    ? `
      <li style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
        Month-over-month change:
        <strong>${escapeHtml(formatSignedCents(autopsy.netChangeCents))}</strong>
        <span style="color:#475569;"> (disputable
        ${escapeHtml(formatCents(autopsy.disputableCents))} ·
        optimization ${escapeHtml(formatCents(autopsy.optimizationCents))})</span>
      </li>`
    : `
      <li style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#475569;">
        Month-over-month change: not enough history yet
      </li>`;

  const topLinesBlock =
    topUnusedLines.length > 0
      ? `
        <h2 style="font-size:14px;font-weight:600;color:#0f172a;margin:24px 0 8px;">
          Top unused lines
        </h2>
        <ul style="list-style:none;padding:0;margin:0 0 24px;font-size:14px;color:#0f172a;">
          ${topUnusedLines
            .slice(0, 3)
            .map((line) => {
              const last4 = escapeHtml(clampLast4(line.mdnMaskedLast4));
              const label = escapeHtml(line.label && line.label.length > 0 ? line.label : 'Line');
              const tag = escapeHtml(ruleLabel(line.ruleId));
              const amount = escapeHtml(formatCents(line.estimatedMonthlySavingsCents));
              return `
              <li style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                <strong>${label}</strong>
                <span style="color:#475569;">(…${last4})</span> —
                ${tag}: <strong>${amount}/mo</strong>
              </li>`;
            })
            .join('')}
        </ul>`
      : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>CarrierAudit — ${safePeriod} digest</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f8fafc;font-family:${FONT_STACK};">
    <div style="padding:24px;">
      <div style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.5;">
        <h1 style="font-size:22px;font-weight:700;margin:0 0 16px;color:#0f172a;">
          Your ${safePeriod} CarrierAudit digest
        </h1>
        <p style="font-size:14px;color:#475569;margin:0 0 20px;">
          Here&apos;s where your wireless spend stands this month and what&apos;s
          still recoverable.
        </p>

        <ul style="list-style:none;padding:0;margin:0 0 24px;font-size:14px;color:#0f172a;">
          <li style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
            Total spend across recent bills:
            <strong>${escapeHtml(formatCents(totalSpendCents))}</strong>
          </li>
          ${autopsyBlock}
          <li style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
            Open findings:
            <strong>${openFindingsBySeverity.high}</strong> high ·
            <strong>${openFindingsBySeverity.medium}</strong> medium ·
            <strong>${openFindingsBySeverity.low}</strong> low
          </li>
          <li style="padding:8px 0;">
            Total recoverable savings:
            <strong style="color:#0f766e;">${escapeHtml(formatCents(totalRecoverableSavingsCents))}/mo</strong>
          </li>
        </ul>
        ${topLinesBlock}
        <a href="${safeDashboard}" style="display:inline-block;background-color:#0f766e;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px;">
          View your dashboard
        </a>

        <div style="margin-top:32px;font-size:12px;color:#475569;line-height:1.5;">
          <p style="margin:0 0 8px;">
            You receive this digest once a month while you have active findings.
          </p>
          <p style="margin:0;">
            CarrierAudit ·
            <a href="${safeUnsub}" style="color:#475569;text-decoration:underline;">
              unsubscribe
            </a>
          </p>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

export function buildMonthlyDigest(props: MonthlyDigestProps): MonthlyDigestRendered {
  return {
    subject: buildSubject(props),
    text: renderMonthlyDigestText(props),
    html: buildHtml(props),
  };
}
