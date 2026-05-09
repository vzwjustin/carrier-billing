/**
 * EDI 811 → ExtractedBill mapper.
 *
 * X12 transaction set 811 ("Consolidated Service Invoice/Statement") is the
 * standardized format US enterprise telecom customers receive their bills in.
 * It's a deterministic, hierarchical text format — once parsed correctly, no
 * LLM or OCR is needed to populate ExtractedBill.
 *
 * Our mapping covers the common 811 segments produced by VZ/AT&T/T-Mobile
 * implementation guides:
 *
 *   - ISA / GS / ST          envelopes (only used for routing + control nums)
 *   - BIG                    invoice date + invoice number
 *   - N1 (qualifier 'VN')    vendor / carrier name
 *   - DTM (150 / 151 / 194)  billing period start / end / "billing date"
 *   - HL                     hierarchy: Bill → Account → Service Point
 *   - REF (qualifiers IT, AN) account number + line/MDN reference
 *   - IT1                    line items per service point (qty * unit_price)
 *   - PID                    plan / feature description
 *   - TXI                    account-level taxes (sum into taxes_fees_cents)
 *   - TDS                    invoice total (N2, implicit cents)
 *   - SE / GE / IEA          envelope close
 *
 * Caveats (TODO(domain) for Justin once we have real samples):
 *   - Each carrier's IG assigns slightly different REF qualifiers and HL
 *     level codes; this mapper uses the X12 standard defaults. Carrier-
 *     specific overrides should live alongside src/extraction/carriers/*.
 *   - We don't decompose IT1s into plan-base vs features yet — every IT1
 *     under a service point sums into plan_base_cents. Splitting requires
 *     PID-driven categorization that's carrier-specific.
 *   - We don't parse credits or DPP installments yet — those typically come
 *     through as additional IT1 lines with negative amounts or specific PID
 *     codes; will be carrier-specific.
 *   - Phone-number identifiers can land in REF*MN, REF*98, or HL ID fields
 *     depending on carrier. We try the common spots; missing MDNs become
 *     null in the schema (which is the documented "unknown" path).
 */

import type {
  ExtractedAccount,
  ExtractedBill,
  ExtractedLine,
  Carrier,
} from '@/extraction/schema';
import {
  ExtractedBillSchema,
} from '@/extraction/schema';

import {
  type X12Segment,
  parseX12,
  partitionTransactionSets,
  findSegment,
  findAllSegments,
  EdiParseError,
} from './parser';

// ─────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────

/** Parse 'CCYYMMDD' (8 digits) → 'YYYY-MM-DD'. Returns null if malformed. */
function parseEdiDate(value: string | undefined): string | null {
  if (!value) return null;
  const digits = value.trim();
  if (!/^\d{8}$/.test(digits)) return null;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  // Cheap sanity check; Date will accept '2026-13-99' silently.
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${month}-${day}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Money helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse an X12 R1 (real-valued) monetary field into integer cents.
 * Used for IT1.04 unit price and similar. "55.00" → 5500, "5500" → 550000.
 */
function parseCents(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/[, ]/g, '');
  if (cleaned.length === 0) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/**
 * Parse an X12 N2 (numeric, implicit 2-decimal) monetary field. The standard
 * convention is "10000" = $100.00 = 10000 cents — i.e. the integer is already
 * in cents. Used by TDS01 (invoice total) and TXI.02 (tax amount).
 *
 * Defensive: if the value contains an explicit decimal point we fall back to
 * R1 semantics to handle non-conforming senders.
 */
function parseImpliedCents(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/[, ]/g, '');
  if (cleaned.length === 0) return null;
  if (cleaned.includes('.')) {
    return parseCents(cleaned);
  }
  if (!/^-?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Read the IT1 quantity (IT1.02). Defaults to 1 when missing/blank. */
function parseQty(value: string | undefined): number {
  if (!value) return 1;
  const trimmed = value.trim();
  if (trimmed.length === 0) return 1;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// ─────────────────────────────────────────────────────────────────────────
// Carrier inference
// ─────────────────────────────────────────────────────────────────────────

const CARRIER_PATTERNS: Array<{ pattern: RegExp; carrier: Carrier }> = [
  { pattern: /verizon/i, carrier: 'verizon' },
  { pattern: /\b(at\s*&\s*t|at\s*and\s*t|attmobility|new\s+cingular)\b/i, carrier: 'att' },
  { pattern: /t[-\s]?mobile/i, carrier: 'tmobile' },
];

function inferCarrierFromSegments(
  segments: ReadonlyArray<X12Segment>,
): Carrier {
  // VN = Vendor (in 811 this is the entity rendering the invoice = the carrier).
  // RE = Receiver (paying party). Fall back to scanning all N1 names.
  const candidates: string[] = [];
  for (const n1 of findAllSegments(segments, 'N1')) {
    const qualifier = (n1.elements[0] ?? '').toUpperCase();
    const name = n1.elements[1] ?? '';
    if (qualifier === 'VN' && name) candidates.unshift(name); // priority
    else if (name) candidates.push(name);
  }
  for (const candidate of candidates) {
    for (const { pattern, carrier } of CARRIER_PATTERNS) {
      if (pattern.test(candidate)) return carrier;
    }
  }
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────
// HL hierarchy walker
// ─────────────────────────────────────────────────────────────────────────

interface HlContext {
  /** HL01 — the level id (string in EDI even though it's a number). */
  id: string;
  /** HL03 — level code: 'BL'(bill) / 'AC'(account) / 'SP'(service point) etc. */
  levelCode: string;
  /** Segments that follow this HL until the next HL at any level. */
  segments: X12Segment[];
}

/**
 * Bucket every non-HL segment under the most-recent HL it falls under.
 * Returns a flat list of HL contexts; structure is recoverable via HL02
 * (parent id) but we don't need a tree for the basic 811 mapper.
 */
function bucketByHl(segments: ReadonlyArray<X12Segment>): HlContext[] {
  const out: HlContext[] = [];
  let current: HlContext | null = null;
  for (const seg of segments) {
    if (seg.tag === 'HL') {
      current = {
        id: (seg.elements[0] ?? '').trim(),
        levelCode: (seg.elements[2] ?? '').trim().toUpperCase(),
        segments: [],
      };
      out.push(current);
    } else if (current) {
      current.segments.push(seg);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Line / account extraction
// ─────────────────────────────────────────────────────────────────────────

const LINE_LEVEL_CODES = new Set(['SP', 'LI', 'PH']); // service point / line item / phone
const ACCOUNT_LEVEL_CODES = new Set(['AC', 'BA', 'BG']); // account / billed account / billing group

function lastFour(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

function extractLineFromHl(ctx: HlContext): ExtractedLine {
  // MDN comes from a REF segment with qualifier MN/98 (Mobile Number) or as
  // HL ID itself when carriers stuff the phone number there.
  let mdn: string | null = null;
  const refs = findAllSegments(ctx.segments, 'REF');
  for (const ref of refs) {
    const qualifier = (ref.elements[0] ?? '').toUpperCase();
    const value = ref.elements[1] ?? '';
    if (qualifier === 'MN' || qualifier === '98' || qualifier === 'TN') {
      mdn = lastFour(value);
      if (mdn) break;
    }
  }
  if (!mdn) mdn = lastFour(ctx.id);

  // Plan / device come from PID segments. F = Free-form description.
  let planName: string | null = null;
  let device: string | null = null;
  for (const pid of findAllSegments(ctx.segments, 'PID')) {
    const itemCharCode = (pid.elements[0] ?? '').toUpperCase();
    if (itemCharCode !== 'F') continue;
    // PID*F**08*<descr>  (PID03 = product/process characteristic code)
    const description = (pid.elements[4] ?? '').trim();
    if (!description) continue;
    if (!planName && /plan|unlimited|pro|start|plus|business/i.test(description)) {
      planName = description;
    } else if (!device && /iphone|galaxy|pixel|hotspot|mifi|ipad/i.test(description)) {
      device = description;
    }
  }

  // Plan base charge — sum every IT1 under this service point. A single SP
  // can carry multiple IT1s (base plan + features + protection) and any of
  // them can be zero-valued (free trials, comp lines), so we accumulate
  // rather than picking the first positive one. Per X12 spec, line amount
  // is qty * unit price (IT1.02 * IT1.04).
  let planBaseCents: number | null = null;
  for (const it1 of findAllSegments(ctx.segments, 'IT1')) {
    // IT1: 01=line-item-id, 02=qty, 03=uom, 04=unit-price, 05=basis-of-unit-price
    const unitCents = parseCents(it1.elements[3]);
    if (unitCents === null) continue;
    const qty = parseQty(it1.elements[1]);
    const amount = Math.round(qty * unitCents);
    planBaseCents = (planBaseCents ?? 0) + amount;
  }

  return {
    mdn_last4: mdn,
    user_label: null,
    device,
    plan_name: planName,
    plan_base_cents: planBaseCents,
    data_used_gb: null,
    voice_used_min: null,
    sms_used_count: null,
    is_suspended: false,
    features: [],
    credits: [],
    dpp_installments: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface Edi811Result {
  bill: ExtractedBill;
  rawText: string;
  detectedCarrier: Carrier;
}

/**
 * Parse an X12 811 file and project it onto ExtractedBill.
 *
 * Throws EdiParseError on malformed envelopes. Returns a bill with
 * carrier='unknown' rather than throwing if the carrier can't be inferred —
 * the rules engine handles unknown-carrier bills.
 */
export function parseEdi811(input: Buffer | string): Edi811Result {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const { segments } = parseX12(text);

  const transactionSets = partitionTransactionSets(segments);
  if (transactionSets.length === 0) {
    throw new EdiParseError('No ST/SE transaction set found');
  }
  // We support a single transaction set per file. Multi-set interchanges are
  // rare for telecom 811; if we encounter them in the wild we'll iterate.
  const txn = transactionSets[0]!;

  // Verify it's actually an 811. ST*<set-id>*<control-num>
  const st = findSegment(txn, 'ST');
  const setId = (st?.elements[0] ?? '').trim();
  if (setId !== '811') {
    throw new EdiParseError(
      `Transaction set is not 811 (got ${setId || 'empty'})`,
    );
  }

  // Carrier — infer from envelope (ISA + GS) AND transaction-set N1s.
  const detectedCarrier = inferCarrierFromSegments([...segments, ...txn]);

  // Billing period: prefer DTM with qualifier 150 (start) + 151 (end). Some
  // IGs use 194 ("billing date") which we treat as end.
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  for (const dtm of findAllSegments(txn, 'DTM')) {
    const qualifier = (dtm.elements[0] ?? '').trim();
    const date = parseEdiDate(dtm.elements[1]);
    if (!date) continue;
    if (qualifier === '150') periodStart = date;
    else if (qualifier === '151' || qualifier === '194') periodEnd = date;
  }

  // BIG date as fallback: BIG01 = invoice date. Often the billing-period end.
  if (!periodEnd) {
    const big = findSegment(txn, 'BIG');
    const bigDate = parseEdiDate(big?.elements[0]);
    if (bigDate) periodEnd = bigDate;
  }
  // If only one bound is present, fall back to making the other equal so the
  // schema (which requires both) accepts it. The rules engine works fine on
  // a same-day window for single-cycle bills.
  if (!periodStart && periodEnd) periodStart = periodEnd;
  if (!periodEnd && periodStart) periodEnd = periodStart;
  if (!periodStart || !periodEnd) {
    throw new EdiParseError(
      'Could not determine billing period (no DTM 150/151/194 or BIG date)',
    );
  }

  // Total: TDS01 (X12 spec: TDS01 is in *implied* cents already — i.e., a
  // value of "12345" means $123.45). We treat it as cents directly per spec.
  const tds = findSegment(txn, 'TDS');
  let totalCents: number | null = null;
  if (tds && tds.elements[0]) {
    const raw = tds.elements[0].trim().replace(/[, ]/g, '');
    if (/^-?\d+$/.test(raw)) {
      const n = Number(raw);
      if (Number.isFinite(n)) totalCents = n;
    }
  }
  if (totalCents === null || totalCents < 0) {
    throw new EdiParseError(
      'Could not determine invoice total (TDS01 missing or invalid)',
    );
  }

  // HL hierarchy → accounts + lines.
  const hlBuckets = bucketByHl(txn);
  const accounts: ExtractedAccount[] = [];
  let currentAccount: ExtractedAccount | null = null;

  for (const ctx of hlBuckets) {
    if (ACCOUNT_LEVEL_CODES.has(ctx.levelCode)) {
      // Account header. Pull account number from REF*AN.
      let acctNumber: string | null = null;
      for (const ref of findAllSegments(ctx.segments, 'REF')) {
        const qualifier = (ref.elements[0] ?? '').toUpperCase();
        if (qualifier === 'AN' || qualifier === 'IT') {
          acctNumber = ref.elements[1] ?? null;
          if (acctNumber) break;
        }
      }
      // Sum any TXI segments at the account level into taxes_fees_cents.
      // X12 TXI.02 is N2 (implicit-2-decimal, integer = cents) — distinct
      // from IT1.04 which is R1. Some senders put non-conforming decimals
      // here; parseImpliedCents falls back gracefully.
      let taxesFeesCents: number | null = null;
      for (const txi of findAllSegments(ctx.segments, 'TXI')) {
        const amt = parseImpliedCents(txi.elements[1]);
        if (amt === null) continue;
        taxesFeesCents = (taxesFeesCents ?? 0) + amt;
      }
      currentAccount = {
        account_number_last4: lastFour(acctNumber),
        label: null,
        total_charges_cents: 0,
        taxes_fees_cents: taxesFeesCents,
        account_level_credits: [],
        lines: [],
      };
      accounts.push(currentAccount);
    } else if (LINE_LEVEL_CODES.has(ctx.levelCode)) {
      if (!currentAccount) {
        // 811 with line-level HLs but no account-level HLs: synthesize a
        // single account so the schema (which requires >=1) accepts it.
        currentAccount = {
          account_number_last4: null,
          label: null,
          total_charges_cents: 0,
          taxes_fees_cents: null,
          account_level_credits: [],
          lines: [],
        };
        accounts.push(currentAccount);
      }
      const line = extractLineFromHl(ctx);
      currentAccount.lines.push(line);
      // null-explicit so 0-valued lines (comp / promo) are still counted.
      if (line.plan_base_cents !== null) {
        currentAccount.total_charges_cents += line.plan_base_cents;
      }
    }
  }

  if (accounts.length === 0) {
    throw new EdiParseError(
      'No accounts found (no HL hierarchy with account or line level codes)',
    );
  }

  // Defensive fallback for malformed 811s where IT1 unit prices were
  // unparseable but TDS01 was readable. Only applied for single-account
  // bills — distributing TDS across multiple accounts blindly would corrupt
  // per-account accounting (and we have no signal for the right split).
  // Multi-account bills with zero-summed lines surface honestly as
  // total_charges_cents=0 on each account; the rules engine treats that as
  // "no charges" rather than fabricating data.
  if (accounts.length === 1 && accounts[0]) {
    if (accounts[0].total_charges_cents === 0) {
      accounts[0].total_charges_cents = totalCents;
    }
  }

  const bill: ExtractedBill = {
    carrier: detectedCarrier,
    billing_period_start: periodStart,
    billing_period_end: periodEnd,
    total_charges_cents: totalCents,
    accounts,
    notes: ['ingested from EDI 811'],
  };

  // Validate against the schema before returning. Throws if our mapping
  // violates a constraint — same contract as the LLM path.
  const parsed = ExtractedBillSchema.parse(bill);

  return {
    bill: parsed,
    rawText: text,
    detectedCarrier,
  };
}
