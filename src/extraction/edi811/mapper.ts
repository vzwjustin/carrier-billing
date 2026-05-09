import type {
  Carrier,
  ExtractedAccount,
  ExtractedBill,
  ExtractedCredit,
  ExtractedDpp,
  ExtractedFeature,
  ExtractedLine,
  FeatureCategory,
} from '@/extraction/schema';
import type { Edi811Segment } from '@/extraction/edi811/parser';
import { el, elOrNull } from '@/extraction/edi811/parser';
import {
  DTM_INVOICE_DATE,
  DTM_SERVICE_PERIOD_END,
  DTM_SERVICE_PERIOD_END_ALT,
  DTM_SERVICE_PERIOD_START,
  DTM_SERVICE_PERIOD_START_ALT,
  HL_ACCOUNT,
  HL_SUBSCRIBER,
  IT1_PLAN_QUALIFIERS,
  N1_BILL_TO,
  PID_FREE_FORM,
  QTY_DATA_GB,
  QTY_SMS_COUNT,
  QTY_VOICE_MIN,
  REF_ACCOUNT_NUMBER,
  REF_BILLING_ACCOUNT,
  REF_MOBILE_NUMBER,
  REF_USER_LABEL,
  SAC_ALLOWANCE,
  SAC_CHARGE,
  SAC_DEVICE_INSTALLMENT,
  SAC_PLAN,
} from '@/extraction/edi811/segments';

/**
 * Categorise a SAC service-id code into our internal feature taxonomy. Returns
 * 'other' for anything we don't recognise — the per-carrier hook can refine.
 */
function defaultFeatureCategory(serviceIdCode: string): FeatureCategory {
  // Insurance / device protection variants commonly use B6xx codes.
  if (/^B6\d{2}$/i.test(serviceIdCode)) return 'insurance';
  // International services typically sit in F2xx.
  if (/^F2\d{2}$/i.test(serviceIdCode)) return 'international';
  // Cloud storage tends to live in F3xx.
  if (/^F3\d{2}$/i.test(serviceIdCode)) return 'cloud';
  // Hotspot / mobile data add-ons.
  if (/^F4\d{2}$/i.test(serviceIdCode)) return 'hotspot';
  return 'other';
}

/** Hooks per carrier — mostly identity, but lets carriers refine names + categories. */
export type CarrierMapHooks = {
  feature?: (input: { serviceIdCode: string; description: string }) => {
    name: string;
    category: FeatureCategory;
  };
  credit?: (input: { serviceIdCode: string; description: string; isPromo: boolean }) => {
    name: string;
    isPromo: boolean;
  };
  planName?: (input: { description: string; productId: string }) => string | null;
};

/**
 * Convert a parsed 811 transaction into an `ExtractedBill`. The walk groups
 * segments by HL hierarchy: HL*1**A starts an account, HL*<n>*<parent>*B
 * starts a subscriber line under whichever account most recently opened.
 *
 * Segments outside any HL loop (DTM, BIG, top-level N1) populate header
 * fields. TDS at the end of the transaction sets total_charges_cents.
 */
export function mapEdi811ToBill(
  segments: Edi811Segment[],
  carrier: Carrier,
  hooks: CarrierMapHooks = {},
): ExtractedBill {
  type LineState = {
    line: ExtractedLine;
    devicePending: string | null;
  };
  type AccountState = {
    hlId: string;
    account: ExtractedAccount;
    lines: LineState[];
    currentLine: LineState | null;
  };

  const accounts: AccountState[] = [];
  let currentAccount: AccountState | null = null;
  let billingPeriodStart: string | null = null;
  let billingPeriodEnd: string | null = null;
  let invoiceDate: string | null = null;
  let totalChargesCents: number | null = null;
  let billToName: string | null = null;
  const notes: string[] = [];

  for (const seg of segments) {
    switch (seg.id) {
      case 'BIG': {
        // BIG01 is invoice date, BIG02 is invoice number.
        const date = parseEdiDate(el(seg, 1));
        if (date) invoiceDate = date;
        break;
      }
      case 'DTM': {
        const qualifier = el(seg, 1);
        const date = parseEdiDate(el(seg, 2));
        if (!date) break;
        if (
          qualifier === DTM_SERVICE_PERIOD_START ||
          qualifier === DTM_SERVICE_PERIOD_START_ALT
        ) {
          billingPeriodStart = date;
        } else if (
          qualifier === DTM_SERVICE_PERIOD_END ||
          qualifier === DTM_SERVICE_PERIOD_END_ALT
        ) {
          billingPeriodEnd = date;
        } else if (qualifier === DTM_INVOICE_DATE) {
          invoiceDate = date;
        }
        break;
      }
      case 'N1': {
        const qualifier = el(seg, 1).toUpperCase();
        const name = elOrNull(seg, 2);
        if (qualifier === N1_BILL_TO && name) {
          billToName = name;
        }
        break;
      }
      case 'HL': {
        const hlId = el(seg, 1);
        const levelCode = el(seg, 3).toUpperCase();
        if (levelCode === HL_ACCOUNT) {
          const account: ExtractedAccount = {
            account_number_last4: null,
            label: billToName,
            total_charges_cents: 0,
            taxes_fees_cents: null,
            account_level_credits: [],
            lines: [],
          };
          const state: AccountState = { hlId, account, lines: [], currentLine: null };
          accounts.push(state);
          currentAccount = state;
        } else if (levelCode === HL_SUBSCRIBER) {
          // If we see a subscriber loop without a parent account, synthesize one.
          if (!currentAccount) {
            const account: ExtractedAccount = {
              account_number_last4: null,
              label: billToName,
              total_charges_cents: 0,
              taxes_fees_cents: null,
              account_level_credits: [],
              lines: [],
            };
            currentAccount = { hlId: '', account, lines: [], currentLine: null };
            accounts.push(currentAccount);
          }
          const line: ExtractedLine = {
            mdn_last4: null,
            user_label: null,
            device: null,
            plan_name: null,
            plan_base_cents: null,
            data_used_gb: null,
            voice_used_min: null,
            sms_used_count: null,
            is_suspended: false,
            features: [],
            credits: [],
            dpp_installments: [],
          };
          const lineState: LineState = { line, devicePending: null };
          currentAccount.lines.push(lineState);
          currentAccount.currentLine = lineState;
        }
        break;
      }
      case 'REF': {
        const qualifier = el(seg, 1).toUpperCase();
        const value = el(seg, 2).trim();
        if (value.length === 0) break;
        if (currentAccount?.currentLine) {
          if (qualifier === REF_MOBILE_NUMBER) {
            currentAccount.currentLine.line.mdn_last4 = lastFourDigits(value);
          } else if (qualifier === REF_USER_LABEL) {
            currentAccount.currentLine.line.user_label = value;
          }
        } else if (currentAccount) {
          if (qualifier === REF_ACCOUNT_NUMBER || qualifier === REF_BILLING_ACCOUNT) {
            currentAccount.account.account_number_last4 = lastFourDigits(value);
          }
        }
        break;
      }
      case 'PID': {
        // PID*F****<description>
        if (!currentAccount?.currentLine) break;
        const itemTypeCode = el(seg, 1).toUpperCase();
        if (itemTypeCode !== PID_FREE_FORM) break;
        const description = elOrNull(seg, 5);
        if (description) {
          currentAccount.currentLine.devicePending = description;
        }
        break;
      }
      case 'IT1': {
        if (!currentAccount?.currentLine) break;
        // IT1*<assigned id>*<qty>*<uom>*<unit price>*<basis>*<product id qual>*<product id>
        const unitPriceRaw = el(seg, 4);
        const productIdQualifier = el(seg, 6).toUpperCase();
        const productId = el(seg, 7);
        // The plan name in 4010 wireless 811s is most reliably the IT1 product
        // id when paired with a known qualifier; some carriers stuff the
        // human-readable name into IT109 instead.
        let planName: string | null = null;
        if (IT1_PLAN_QUALIFIERS.has(productIdQualifier)) {
          planName = elOrNull(seg, 7) ?? elOrNull(seg, 9);
        } else {
          planName = elOrNull(seg, 9);
        }
        if (hooks.planName) {
          planName = hooks.planName({
            description: planName ?? '',
            productId,
          });
        }
        if (planName) {
          currentAccount.currentLine.line.plan_name = planName;
        }
        const unitPriceCents = parseDollarsToCents(unitPriceRaw);
        if (unitPriceCents !== null && unitPriceCents > 0) {
          currentAccount.currentLine.line.plan_base_cents = unitPriceCents;
        }
        // Promote any pending PID device description onto the line.
        if (
          currentAccount.currentLine.devicePending &&
          !currentAccount.currentLine.line.device
        ) {
          currentAccount.currentLine.line.device =
            currentAccount.currentLine.devicePending;
        }
        break;
      }
      case 'SAC': {
        const indicator = el(seg, 1).toUpperCase();
        const serviceIdCode = el(seg, 2).toUpperCase();
        const amountCents = parseSacAmount(el(seg, 5));
        // SAC15 is the canonical free-form description in 4010 wireless 811s,
        // but some carriers stuff it into SAC14 or SAC12 instead. Try in order.
        const description =
          elOrNull(seg, 15) ?? elOrNull(seg, 14) ?? elOrNull(seg, 12) ?? '';
        if (amountCents === null) break;

        // Device installment (DPP). Always rolls up to the current line.
        if (serviceIdCode === SAC_DEVICE_INSTALLMENT) {
          if (currentAccount?.currentLine && amountCents > 0) {
            const dpp: ExtractedDpp = {
              device:
                description ||
                currentAccount.currentLine.line.device ||
                'Device installment',
              monthly_cents: amountCents,
              remaining_payments: parseIntOrNull(el(seg, 7)),
              total_payments: parsePositiveIntOrNull(el(seg, 8)),
            };
            currentAccount.currentLine.line.dpp_installments.push(dpp);
          }
          break;
        }

        // Plan base charge — populates plan_base_cents only if not already set
        // by an IT1 segment for the same line.
        if (
          serviceIdCode === SAC_PLAN &&
          indicator === SAC_CHARGE &&
          currentAccount?.currentLine
        ) {
          if (currentAccount.currentLine.line.plan_base_cents === null) {
            currentAccount.currentLine.line.plan_base_cents = amountCents;
          }
          if (!currentAccount.currentLine.line.plan_name && description) {
            currentAccount.currentLine.line.plan_name = description;
          }
          break;
        }

        // Allowance → credit (always non-positive at the schema boundary).
        if (indicator === SAC_ALLOWANCE) {
          const isPromo = isPromoCode(serviceIdCode);
          const hookOut = hooks.credit?.({
            serviceIdCode,
            description,
            isPromo,
          }) ?? { name: description || `Credit ${serviceIdCode}`, isPromo };
          // X12 SAC sends positive amounts even for allowances; the
          // indicator + sign convention determines whether it's a credit.
          // We force the sign negative here to match the schema invariant.
          const signedCents = -Math.abs(amountCents);
          const credit: ExtractedCredit = {
            name: hookOut.name,
            monthly_cents: signedCents,
            expires_on: null,
            is_promo: hookOut.isPromo,
          };
          if (currentAccount?.currentLine) {
            currentAccount.currentLine.line.credits.push(credit);
          } else if (currentAccount) {
            currentAccount.account.account_level_credits.push(credit);
          }
          break;
        }

        // Charge → feature. Skip plan code (already handled) and SAC entries
        // that look like header-level totals (no current line and no current
        // account, which shouldn't happen but is defensive).
        if (indicator === SAC_CHARGE && currentAccount?.currentLine) {
          const hookOut = hooks.feature?.({ serviceIdCode, description }) ?? {
            name: description || `Service ${serviceIdCode}`,
            category: defaultFeatureCategory(serviceIdCode),
          };
          const feature: ExtractedFeature = {
            name: hookOut.name,
            category: hookOut.category,
            monthly_cents: amountCents,
          };
          currentAccount.currentLine.line.features.push(feature);
        }
        break;
      }
      case 'QTY': {
        if (!currentAccount?.currentLine) break;
        const qualifier = el(seg, 1).toUpperCase();
        const valueRaw = el(seg, 2);
        const numeric = Number(valueRaw);
        if (!Number.isFinite(numeric) || numeric < 0) break;
        if (qualifier === QTY_DATA_GB) {
          currentAccount.currentLine.line.data_used_gb = numeric;
        } else if (qualifier === QTY_VOICE_MIN) {
          currentAccount.currentLine.line.voice_used_min = Math.round(numeric);
        } else if (qualifier === QTY_SMS_COUNT) {
          currentAccount.currentLine.line.sms_used_count = Math.round(numeric);
        }
        break;
      }
      case 'TXI': {
        // Tax / fee row. Sum all of them into the account's taxes_fees_cents.
        if (!currentAccount) break;
        const amountCents = parseDollarsToCents(el(seg, 2));
        if (amountCents === null || amountCents <= 0) break;
        const current = currentAccount.account.taxes_fees_cents ?? 0;
        currentAccount.account.taxes_fees_cents = current + amountCents;
        break;
      }
      case 'TDS': {
        // TDS01 is the total amount in cents (X12 4010 wireless guides).
        const total = parseTdsAmount(el(seg, 1));
        if (total !== null) totalChargesCents = total;
        break;
      }
      case 'NTE': {
        const note = elOrNull(seg, 2);
        if (note) notes.push(note);
        break;
      }
      default:
        break;
    }
  }

  // Roll the per-account totals up. If TDS gave us a top-level total but no
  // account-level total exists, distribute it onto the (single) account so
  // the rules engine has something sensible to work with.
  for (const acc of accounts) {
    acc.account.lines = acc.lines.map((s) => s.line);
    acc.account.total_charges_cents = sumAccountTotal(acc.account);
  }
  if (totalChargesCents !== null && accounts.length === 1 && accounts[0]) {
    accounts[0].account.total_charges_cents = totalChargesCents;
  }
  if (totalChargesCents === null) {
    totalChargesCents = accounts.reduce(
      (sum, a) => sum + a.account.total_charges_cents,
      0,
    );
  }

  // If we didn't pick up an explicit billing period from DTM, fall back to a
  // 30-day window ending at the invoice date so the schema validation passes.
  if (!billingPeriodStart || !billingPeriodEnd) {
    const ref = invoiceDate ?? today();
    const fallback = inferBillingPeriod(ref);
    if (!billingPeriodStart) billingPeriodStart = fallback.start;
    if (!billingPeriodEnd) billingPeriodEnd = fallback.end;
  }

  return {
    carrier,
    billing_period_start: billingPeriodStart,
    billing_period_end: billingPeriodEnd,
    total_charges_cents: totalChargesCents,
    accounts: accounts.map((a) => a.account),
    notes,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Last 4 digits of a string, or null if there aren't 4 digits to extract. */
function lastFourDigits(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/**
 * X12 dates are CCYYMMDD (DTM02) or YYMMDD (DTM02 in older 4010 dialects).
 * Returns ISO `YYYY-MM-DD` or null if the format is unrecognised.
 */
function parseEdiDate(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  if (trimmed.length === 8) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  }
  if (trimmed.length === 6) {
    // 2-digit year: pivot at 70 — anything <70 is 20xx, else 19xx.
    const yy = Number(trimmed.slice(0, 2));
    const century = yy < 70 ? 2000 : 1900;
    const year = String(century + yy).padStart(4, '0');
    return `${year}-${trimmed.slice(2, 4)}-${trimmed.slice(4, 6)}`;
  }
  return null;
}

/** Convert a dollars string ('60.00') to integer cents. Returns null on failure. */
function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/**
 * SAC05 is the monetary amount. The X12 wireless 4010 convention encodes
 * amounts as integer cents (no decimal point); the 5010 convention sometimes
 * uses dollars with two decimals. Sniff the format and accept both.
 */
function parseSacAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // If a decimal point is present we treat the value as dollars.
  if (trimmed.includes('.')) return parseDollarsToCents(trimmed);
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
}

/**
 * TDS01 is an integer in cents per the 4010 spec. Accept dollar-string
 * variants for compatibility with carriers that drift toward 5010 style.
 */
function parseTdsAmount(raw: string): number | null {
  return parseSacAmount(raw);
}

function parseIntOrNull(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function parsePositiveIntOrNull(raw: string): number | null {
  const n = parseIntOrNull(raw);
  if (n === null || n <= 0) return null;
  return n;
}

function isPromoCode(code: string): boolean {
  // F0xx is the promotional / temporary credit family in our internal taxonomy.
  return /^F0\d{2}$/i.test(code);
}

function sumAccountTotal(account: ExtractedAccount): number {
  let total = 0;
  for (const line of account.lines) {
    total += line.plan_base_cents ?? 0;
    for (const f of line.features) total += f.monthly_cents;
    for (const c of line.credits) total += c.monthly_cents; // credits are negative
    for (const d of line.dpp_installments) total += d.monthly_cents;
  }
  for (const c of account.account_level_credits) total += c.monthly_cents;
  if (account.taxes_fees_cents) total += account.taxes_fees_cents;
  return Math.max(total, 0);
}

function today(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function inferBillingPeriod(reference: string): { start: string; end: string } {
  const d = new Date(`${reference}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    return { start: reference, end: reference };
  }
  const end = new Date(d);
  const start = new Date(d);
  start.setUTCDate(start.getUTCDate() - 29);
  return { start: toIso(start), end: toIso(end) };
}

function toIso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
