/**
 * Pure builder for the **bulk dispute letter** — a single multi-page formal
 * letter that bundles multiple approved findings on the same audit.
 *
 * Mirrors the data discipline of the per-finding `builder.ts`:
 *   - No I/O. Caller pre-loads + filters the rows.
 *   - MDNs render as `*1234`, account numbers as `…1234`.
 *   - No employee names, no raw bill text.
 *   - Sum / annual / period strings are derived deterministically here so a
 *     downstream renderer can never silently disagree with the text it ships.
 *
 * Per CLAUDE.md §1#7 ("no premature abstraction") we keep this separate from
 * `builder.ts` rather than over-generalising — the shapes serve very
 * different surfaces (a one-finding packet vs a numbered formal letter) and
 * collapsing them would force the per-finding renderer to special-case
 * "section heading / item list / total" plumbing it doesn't need.
 */
import type {
  DisputeAccountInput,
  DisputeAuditInput,
  DisputeFindingInput,
  DisputeLineInput,
  DisputeSeverity,
} from './builder';
import { formatIsoDatePeriod, formatUtcYyyyMmDd } from '@/lib/dates';

const CARRIER_DISPLAY_NAMES: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  unknown: 'Unknown carrier',
};

/** Fallback display name when the operator's profile has no `full_name`. */
const DEFAULT_OPERATOR_NAME = 'Operator';

export interface BulkDisputeBuilderInput {
  audit: DisputeAuditInput;
  /**
   * Pre-resolved operator display name from `profiles.full_name`. May be
   * `null` (legacy / unset) — the builder substitutes `"Operator"` so the
   * closing block always has a name to render.
   */
  operatorName: string | null;
  /**
   * The set of findings to dispute. The caller must have already validated
   * that every finding belongs to `audit.id` AND has `status='approved'`.
   * The builder does no further filtering — feed it the list, get the
   * letter.
   *
   * Empty arrays are allowed: the result is an empty letter (`items: []`,
   * `totalRequestedCreditCents: 0`). The route enforces a non-empty
   * selection at the boundary so the empty shape is purely a defensive
   * convenience for tests + downstream renderers.
   */
  findings: BulkDisputeFindingInput[];
  /**
   * Stable "now" injected by the caller — used for the date line + footer.
   * Mirrors the per-finding builder's `generatedAt` contract.
   */
  generatedAt: Date;
}

/**
 * A finding plus the bill_lines + bill_accounts rows the caller already
 * joined for it. The route fetches lines/accounts in a single batched query
 * and then groups them by finding so the builder stays I/O-free.
 */
export interface BulkDisputeFindingInput {
  finding: DisputeFindingInput;
  lines: DisputeLineInput[];
  accounts: DisputeAccountInput[];
}

export interface BulkDisputeItemDisplay {
  /** 1-based, for the numbered list ("Item 1 of N"). */
  itemNumber: number;
  /** Stable rule id (small chip in the renderer). */
  ruleId: string;
  /** Capitalized severity label for the chip. */
  severityLabel: string;
  severity: DisputeSeverity;
  /** Finding title verbatim. */
  title: string;
  /** Description paragraph (source-of-truth — author-written, PII-free). */
  description: string;
  /** Recommended action paragraph. */
  recommendedAction: string;
  /**
   * Affected line MDNs as last-4 strings prefixed with `*`. Order is
   * preserved from the caller's input. Empty when no specific lines apply.
   */
  affectedMdns: string[];
  /**
   * Account chip strings (label + last-4 fallback). Empty when no specific
   * accounts apply.
   */
  affectedAccounts: string[];
  /** Plain integer cents, monthly. */
  requestedCreditCents: number;
  /** Formatted display (`$24.00/mo`). */
  requestedCreditDisplay: string;
}

export interface BulkDisputeLetter {
  /** Carrier full name (`Verizon`, `AT&T`, `T-Mobile`, `Unknown carrier`). */
  carrierName: string;
  /** Lowercase slug — useful for downstream branching. */
  carrierSlug: string;
  /** `Apr 1, 2026 – Apr 30, 2026` or `—` when unknown. */
  billingPeriodDisplay: string;
  /** First 8 chars of the audit UUID — letter reference number. */
  auditShortId: string;
  /** ISO date string (`2026-05-25`). */
  generatedDateDisplay: string;
  /** Human date string (`May 25, 2026`) for the letter heading. */
  generatedDateLong: string;
  /**
   * Operator's display name — `profiles.full_name`, or `"Operator"` when
   * the profile didn't have one.
   */
  operatorName: string;
  /** The numbered list of dispute items. */
  items: BulkDisputeItemDisplay[];
  /** Sum of every item's monthly cents, in plain integer cents. */
  totalRequestedCreditCents: number;
  /** Formatted total (`$73.00/mo`). */
  totalRequestedCreditDisplay: string;
  /** Twelve-month equivalent of the sum, in plain integer cents. */
  totalRequestedCreditAnnualCents: number;
  /** Formatted annual total (`$876.00`). */
  totalRequestedCreditAnnualDisplay: string;
  /**
   * Formal closing salutation block, pre-rendered as a list of lines so
   * the renderer can lay them out without doing any business logic.
   */
  closingBlock: string[];
}

// ---------------------------------------------------------------------------
// Helpers — local copies of the per-finding builder's formatters. Inlined
// rather than re-exported so this module stays a leaf with no UI deps.
// ---------------------------------------------------------------------------

function carrierDisplay(slug: string | null): {
  slug: string;
  name: string;
} {
  const key = (slug ?? 'unknown').toLowerCase();
  const name = CARRIER_DISPLAY_NAMES[key] ?? CARRIER_DISPLAY_NAMES['unknown'];
  return { slug: key, name: name ?? 'Unknown carrier' };
}

function formatLongDate(d: Date): string {
  // UTC-anchored long form (`May 25, 2026`). Drives the letter heading.
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const monthName = months[m] ?? 'January';
  return `${monthName} ${day}, ${y}`;
}

function formatCentsDollars(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(dollars);
}

function formatMdn(mdn: string | null): string {
  if (!mdn) return '—';
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

function renderAccountChip(account: DisputeAccountInput): string {
  const number = formatAcct(account.account_number_masked);
  if (account.account_label && number !== '—') {
    return `${account.account_label} (${number})`;
  }
  if (account.account_label) return account.account_label;
  return number;
}

function resolveOperatorName(raw: string | null): string {
  if (raw === null) return DEFAULT_OPERATOR_NAME;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_OPERATOR_NAME;
  return trimmed;
}

/**
 * Build the bulk dispute letter shape. Pure, deterministic — feed it rows +
 * a `Date` and you'll get the same letter every time.
 */
export function buildBulkDisputeLetter(input: BulkDisputeBuilderInput): BulkDisputeLetter {
  const { audit, operatorName, findings, generatedAt } = input;

  const carrier = carrierDisplay(audit.carrier);
  const billingPeriodDisplay = formatIsoDatePeriod(
    audit.billing_period_start,
    audit.billing_period_end,
  );

  const items: BulkDisputeItemDisplay[] = findings.map((entry, idx) => {
    const { finding, lines, accounts } = entry;
    const monthlyCents = finding.estimated_monthly_savings_cents;
    return {
      itemNumber: idx + 1,
      ruleId: finding.rule_id,
      severityLabel: severityLabel(finding.severity),
      severity: finding.severity,
      title: finding.title,
      description: finding.description,
      recommendedAction: finding.recommended_action,
      affectedMdns: lines.map((l) => formatMdn(l.mdn_masked)),
      affectedAccounts: accounts.map(renderAccountChip),
      requestedCreditCents: monthlyCents,
      requestedCreditDisplay: `${formatCentsDollars(monthlyCents)}/mo`,
    };
  });

  const totalCents = items.reduce((sum, item) => sum + item.requestedCreditCents, 0);
  const totalAnnualCents = totalCents * 12;
  const resolvedName = resolveOperatorName(operatorName);

  const closingBlock = [
    'Please open billing-adjustment tickets for each item above, confirm the',
    'credits going forward, and send written confirmation with the ticket',
    'numbers for my records.',
    '',
    'Sincerely,',
    '',
    resolvedName,
  ];

  return {
    carrierName: carrier.name,
    carrierSlug: carrier.slug,
    billingPeriodDisplay,
    auditShortId: audit.id.slice(0, 8),
    generatedDateDisplay: formatUtcYyyyMmDd(generatedAt),
    generatedDateLong: formatLongDate(generatedAt),
    operatorName: resolvedName,
    items,
    totalRequestedCreditCents: totalCents,
    totalRequestedCreditDisplay: `${formatCentsDollars(totalCents)}/mo`,
    totalRequestedCreditAnnualCents: totalAnnualCents,
    totalRequestedCreditAnnualDisplay: formatCentsDollars(totalAnnualCents),
    closingBlock,
  };
}
