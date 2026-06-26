/**
 * Pure data shaper for the dispute packet (PDF + email + phone script).
 *
 * No I/O, no time, no env reads — every caller (route, email builder, PDF
 * renderer, tests) feeds in pre-loaded rows and gets back a deterministic
 * shape. Side effects live at the route boundary.
 *
 * PII discipline (CLAUDE.md §1#5):
 *  - MDNs render as `*1234` (the bill_lines.mdn_masked column already stores
 *    only last-4; we re-prefix here so a downstream renderer can't accidentally
 *    emit a raw value if the column shape ever changes).
 *  - Account numbers render as `…1234`.
 *  - No employee names, no raw bill text. We use the rule-engine's
 *    description + recommended_action verbatim because those strings are
 *    authored by us and already PII-free.
 */

import { formatIsoDatePeriod, formatUtcYyyyMmDd } from '@/lib/dates';

const CARRIER_DISPLAY_NAMES: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  unknown: 'Unknown carrier',
};

export type DisputeSeverity = 'high' | 'medium' | 'low' | 'info';

/**
 * Minimal audit columns the dispute packet needs. Keep this narrow — adding
 * fields here forces every caller (route, tests) to widen its SELECT.
 */
export interface DisputeAuditInput {
  id: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
}

/**
 * Minimal finding columns the dispute packet needs. Sourced from the
 * `findings` table; `affected_line_ids` is the canonical link to bill_lines.
 */
export interface DisputeFindingInput {
  id: string;
  rule_id: string;
  severity: DisputeSeverity;
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number;
  confidence: number;
  affected_line_ids: string[] | null;
  affected_account_ids: string[] | null;
}

/** Minimal bill_lines columns the affected-lines table needs. */
export interface DisputeLineInput {
  id: string;
  /** Last-4 of the MDN, or null if the carrier didn't surface it. */
  mdn_masked: string | null;
  plan_name: string | null;
}

/** Minimal bill_accounts columns used for the account-id chip in the header. */
export interface DisputeAccountInput {
  id: string;
  /** Last-4 of the account number, or null if not available. */
  account_number_masked: string | null;
  account_label: string | null;
}

export interface DisputeBuilderInput {
  audit: DisputeAuditInput;
  finding: DisputeFindingInput;
  /**
   * Pre-filtered to the lines referenced by `finding.affected_line_ids`.
   * The route is responsible for the WHERE-clause; the builder just shapes.
   */
  lines: DisputeLineInput[];
  /**
   * Pre-filtered to the accounts referenced by `finding.affected_account_ids`.
   * Empty array is fine; the header degrades to "—".
   */
  accounts: DisputeAccountInput[];
  /**
   * Stable "now" injected by the caller — we render the generation date in
   * the footer/email body. Never call `new Date()` inside the builder so
   * snapshot tests stay deterministic.
   */
  generatedAt: Date;
}

/** Display-ready affected line row. */
export interface DisputeLineDisplay {
  /** Always prefixed with `*` (e.g. `*1234`) or `—` when MDN unknown. */
  mdnDisplay: string;
  /** Plan name, or `—` when missing. */
  planDisplay: string;
}

/** Display-ready account chip for the header. */
export interface DisputeAccountDisplay {
  /** `…1234` when known, `—` when not. */
  numberDisplay: string;
  label: string | null;
}

export interface DisputePacket {
  /** Carrier full name (`Verizon`, `AT&T`, `T-Mobile`, `Unknown carrier`). */
  carrierName: string;
  /** Lowercase carrier slug (or `unknown`) — useful for downstream branching. */
  carrierSlug: string;
  /** Pre-formatted billing-period string (`Apr 1, 2026 – Apr 30, 2026`). */
  billingPeriodDisplay: string;
  /** ISO-formatted generation date (`2026-05-25`) — used in PDF footer + email. */
  generatedDateDisplay: string;
  /** First 8 chars of the audit UUID — useful for an at-a-glance reference. */
  auditShortId: string;
  /** Finding title verbatim. */
  findingTitle: string;
  /** Capitalized severity for the header chip. */
  severityLabel: string;
  /** Severity bucket for color/badge logic in renderers. */
  severity: DisputeSeverity;
  /** Stable rule id, surfaced as a small chip. */
  ruleId: string;
  /** Integer 0..100 derived from `confidence`. */
  confidencePercent: number;
  /** Requested credit, formatted to USD (e.g. `$24.00/mo`). */
  requestedCreditDisplay: string;
  /** Plain-cents requested credit (monthly). Caller can multiply for annual. */
  requestedCreditCents: number;
  /** Twelve-month equivalent of the monthly credit. */
  requestedCreditAnnualCents: number;
  /** Description paragraph, source-of-truth for the explanation block. */
  description: string;
  /** Recommended action paragraph. */
  recommendedAction: string;
  /** Affected line rows for the table. */
  affectedLines: DisputeLineDisplay[];
  /** Header chips listing each affected account number (last-4). */
  accounts: DisputeAccountDisplay[];
  /** Bullet points the operator can read aloud to a carrier rep. */
  phoneScript: string[];
}

function carrierDisplay(slug: string | null): {
  slug: string;
  name: string;
} {
  const key = (slug ?? 'unknown').toLowerCase();
  const name = CARRIER_DISPLAY_NAMES[key] ?? CARRIER_DISPLAY_NAMES['unknown'];
  return { slug: key, name: name ?? 'Unknown carrier' };
}

function formatCentsDollars(cents: number): string {
  // Mirrors `formatCents` in src/lib/utils.ts but inlined — that helper pulls
  // in clsx/twMerge through its module index and we want the builder to stay
  // a leaf module with no UI deps.
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(dollars);
}

function formatMdn(mdn: string | null): string {
  if (!mdn) return '—';
  // The DB column already stores last-4 only, but we re-prefix defensively so
  // a longer string (e.g. an accidental fully-qualified number) collapses to
  // the last 4 visible characters.
  const last4 = mdn.length <= 4 ? mdn : mdn.slice(-4);
  return `*${last4}`;
}

function formatAcct(masked: string | null): string {
  if (!masked) return '—';
  const last4 = masked.length <= 4 ? masked : masked.slice(-4);
  return `…${last4}`;
}

function severityLabel(s: DisputeSeverity): string {
  switch (s) {
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'low':
      return 'Low';
    case 'info':
      return 'Info';
  }
}

function clampConfidencePercent(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return Math.round(clamped * 100);
}

/**
 * The operator reads these bullets aloud when calling the carrier rep. We
 * derive them from the same finding fields the PDF renders, so the script
 * never drifts from the explanation block. Keep them short — a person is
 * speaking them.
 */
function buildPhoneScript(args: {
  carrierName: string;
  findingTitle: string;
  requestedCreditDisplay: string;
  requestedCreditAnnualCents: number;
  affectedLineCount: number;
  accountChips: DisputeAccountDisplay[];
  billingPeriodDisplay: string;
  recommendedAction: string;
}): string[] {
  const {
    carrierName,
    findingTitle,
    requestedCreditDisplay,
    requestedCreditAnnualCents,
    affectedLineCount,
    accountChips,
    billingPeriodDisplay,
    recommendedAction,
  } = args;

  const accountPhrase =
    accountChips.length === 0
      ? 'my account'
      : accountChips.length === 1
        ? `my account ending ${accountChips[0]?.numberDisplay ?? '—'}`
        : `my ${accountChips.length} accounts`;

  const linePhrase =
    affectedLineCount === 0
      ? 'on my bill'
      : affectedLineCount === 1
        ? 'on one of my lines'
        : `across ${affectedLineCount} lines`;

  const annualDisplay = formatCentsDollars(requestedCreditAnnualCents);

  return [
    `Hi, I'm calling about a billing issue on ${accountPhrase} with ${carrierName}.`,
    `I ran an audit on my ${billingPeriodDisplay} bill and identified an issue: ${findingTitle.toLowerCase()} ${linePhrase}.`,
    `Based on this, I'm requesting a credit of ${requestedCreditDisplay} monthly — that's roughly ${annualDisplay} over the next year if it isn't corrected.`,
    `My specific request: ${recommendedAction}`,
    `Could you open a billing-adjustment ticket and confirm the monthly credit going forward?`,
    `Please send me written confirmation of the adjustment and the ticket number for my records.`,
  ];
}

/**
 * Build the dispute packet shape. Pure, deterministic — feed it rows + a
 * `Date` and you'll get the same packet every time.
 */
export function buildDisputePacket(input: DisputeBuilderInput): DisputePacket {
  const { audit, finding, lines, accounts, generatedAt } = input;

  const carrier = carrierDisplay(audit.carrier);
  const monthlyCents = finding.estimated_monthly_savings_cents;
  const annualCents = monthlyCents * 12;

  // Per-line affected rows. Order is preserved from the caller; the route
  // is expected to fetch lines in a deterministic order (e.g. by id).
  const affectedLines: DisputeLineDisplay[] = lines.map((l) => ({
    mdnDisplay: formatMdn(l.mdn_masked),
    planDisplay: l.plan_name ?? '—',
  }));

  const accountChips: DisputeAccountDisplay[] = accounts.map((a) => ({
    numberDisplay: formatAcct(a.account_number_masked),
    label: a.account_label,
  }));

  const requestedCreditDisplay = `${formatCentsDollars(monthlyCents)}/mo`;
  const billingPeriodDisplay = formatIsoDatePeriod(
    audit.billing_period_start,
    audit.billing_period_end,
  );

  const phoneScript = buildPhoneScript({
    carrierName: carrier.name,
    findingTitle: finding.title,
    requestedCreditDisplay,
    requestedCreditAnnualCents: annualCents,
    affectedLineCount: affectedLines.length,
    accountChips,
    billingPeriodDisplay,
    recommendedAction: finding.recommended_action,
  });

  return {
    carrierName: carrier.name,
    carrierSlug: carrier.slug,
    billingPeriodDisplay,
    generatedDateDisplay: formatUtcYyyyMmDd(generatedAt),
    auditShortId: audit.id.slice(0, 8),
    findingTitle: finding.title,
    severityLabel: severityLabel(finding.severity),
    severity: finding.severity,
    ruleId: finding.rule_id,
    confidencePercent: clampConfidencePercent(finding.confidence),
    requestedCreditDisplay,
    requestedCreditCents: monthlyCents,
    requestedCreditAnnualCents: annualCents,
    description: finding.description,
    recommendedAction: finding.recommended_action,
    affectedLines,
    accounts: accountChips,
    phoneScript,
  };
}
