import { z } from 'zod';

// Carriers we support. Anything we can't classify is 'unknown'.
//
// `uscellular`, `spectrum`, `xfinity`, `cricket` were added alongside
// migration 0032: regional carriers + US MVNOs that show up on real
// SignalAudit deployments. Spectrum/Xfinity ride Verizon's network and
// Cricket rides AT&T's, but the bills print distinctive headers and have
// MVNO-specific plan SKUs — see `detect.ts` for the tie-breaker (prefer
// the MVNO match over the underlying-network match).
export const CarrierSchema = z.enum([
  'verizon',
  'att',
  'tmobile',
  'uscellular',
  'spectrum',
  'xfinity',
  'cricket',
  'unknown',
]);
export type Carrier = z.infer<typeof CarrierSchema>;

// Feature classification. Keeps the rules engine surface small and stable.
export const FeatureCategorySchema = z.enum([
  'insurance',
  'international',
  'cloud',
  'hotspot',
  'addon',
  'other',
]);
export type FeatureCategory = z.infer<typeof FeatureCategorySchema>;

export const ExtractedFeatureSchema = z.object({
  // (M-E1) Bound free-text length: SAC15 descriptions in some carrier 811s
  // can include multi-line marketing copy. 120 chars is plenty for a feature
  // name and prevents an oversized string from bloating logs / Sentry.
  name: z.string().min(1).max(120),
  category: FeatureCategorySchema.default('other'),
  monthly_cents: z.number().int().nonnegative().max(1_000_000),
});
export type ExtractedFeature = z.infer<typeof ExtractedFeatureSchema>;

export const ExtractedCreditSchema = z.object({
  name: z.string().min(1).max(120),
  // Credits as printed on the bill are non-positive: a $10/mo discount shows
  // as -1000, and the rare zero-value placeholder shows as 0. A positive
  // value here means the LLM (or carrier normalizer) flipped the sign and
  // would silently turn a $10 discount into a $10 charge once we treat the
  // value as signed elsewhere — reject at the schema boundary so we never
  // persist that.
  monthly_cents: z
    .number()
    .int()
    .refine((v) => v <= 0, {
      message: 'Credit monthly_cents must be 0 or negative (signed)',
    }),
  expires_on: z.string().date().nullable(),
  is_promo: z.boolean().default(true),
});
export type ExtractedCredit = z.infer<typeof ExtractedCreditSchema>;

export const ExtractedDppSchema = z
  .object({
    // Bound length so a model leak of full device/PII strings can't bloat logs
    // or, via Sentry beforeSend, exfiltrate large bodies. 40 chars covers all
    // canonical SKU strings ("iPhone 15 Pro Max 256GB" is 22).
    device: z.string().min(1).max(40),
    monthly_cents: z.number().int().nonnegative().max(1_000_000),
    remaining_payments: z.number().int().nonnegative().nullable(),
    total_payments: z.number().int().positive().nullable(),
  })
  // A device-payment plan can never have more payments left than its total
  // term (e.g. "month 12 of 24" → remaining 12, total 24). An LLM transcription
  // slip that inverts the two would silently corrupt every "months remaining" /
  // "percent complete" calculation downstream, so reject it at the boundary.
  // Null on either side means "not printed" and is left unconstrained.
  .refine(
    (d) =>
      d.remaining_payments === null ||
      d.total_payments === null ||
      d.remaining_payments <= d.total_payments,
    {
      message: 'remaining_payments cannot exceed total_payments',
      // Point the issue at the offending field rather than the whole DPP object
      // so the retry-on-validation feedback in llm.ts (which joins issue.path)
      // tells the model exactly which field to fix.
      path: ['remaining_payments'],
    },
  );
export type ExtractedDpp = z.infer<typeof ExtractedDppSchema>;

// H10: defense-in-depth name redaction. The LLM prompt instructs the model to
// strip personal names from user_label, but EDI REF*EM and CSV "User Name"
// columns can carry names verbatim. Ambiguous human-looking labels are nulled
// before persistence; operational labels remain useful for routing work back
// to a department, store, line number, device pool, or cost center.
const SAFE_USER_LABEL_RE =
  /^(?:department|dept(?:artment)?(?:\s*[#:-]?\s*[a-z0-9]+)?|store(?:\s*[#:-]?\s*[a-z0-9]+)?|line\s+\d+|tablet|router|employee\s+[a-z]|\w{2,8}[-_]\d{2,}|cost\s*center(?:\s*[#:-]?\s*[a-z0-9]+)?|cc[-_\s]?\d{2,}|sales|finance|legal|hr|ops|field\s+tech|warehouse|office|admin|support|marketing|engineering|dispatch|fleet)$/i;

const COMMON_GIVEN_NAMES = new Set([
  'alice',
  'bob',
  'carol',
  'dana',
  'eve',
  'frank',
  'grace',
  'jane',
  'john',
  'mary',
]);

function isNameToken(token: string): boolean {
  const normalized = token.toLowerCase().replace(/[^a-z'-]/g, '');
  if (COMMON_GIVEN_NAMES.has(normalized)) return true;
  return /^[A-Z][a-z]+(?:['-][A-Z]?[a-z]+)?$/.test(token) || /^[A-Z]{2,}$/.test(token);
}

export function sanitizeUserLabel(label: string | null): string | null {
  if (label === null) return null;
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  if (SAFE_USER_LABEL_RE.test(trimmed)) return trimmed;

  const tokens = trimmed.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (tokens.length === 1 && COMMON_GIVEN_NAMES.has(tokens[0]!.toLowerCase())) {
    return null;
  }
  if (tokens.length >= 2 && tokens.length <= 4 && tokens.every(isNameToken)) {
    return null;
  }

  return trimmed;
}

export const ExtractedLineSchema = z.object({
  mdn_last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  // Free-text PII risk: X12 REF*EM emits subscriber names verbatim.
  // Bound length so an oversized payload can't be persisted or echoed in logs.
  // H10: transform nulls likely human subscriber names while preserving
  // operational labels that help operators identify safe non-human lines.
  user_label: z
    .string()
    .max(40)
    .nullable()
    .transform(sanitizeUserLabel),
  device: z.string().max(40).nullable(),
  plan_name: z.string().max(120).nullable(),
  plan_base_cents: z.number().int().nonnegative().max(10_000_000).nullable(),
  // (L) Cap absurd values. 10TB/month is far above any real cellular plan
  // and a 4–5 digit decimal here is almost always a parse error feeding
  // through. Clipping at the schema boundary keeps reports legible.
  data_used_gb: z.number().nonnegative().max(10_000).nullable(),
  voice_used_min: z.number().int().nonnegative().nullable(),
  sms_used_count: z.number().int().nonnegative().nullable(),
  is_suspended: z.boolean().default(false),
  features: z.array(ExtractedFeatureSchema).default([]),
  credits: z.array(ExtractedCreditSchema).default([]),
  dpp_installments: z.array(ExtractedDppSchema).default([]),
});
export type ExtractedLine = z.infer<typeof ExtractedLineSchema>;

export const ExtractedAccountSchema = z.object({
  account_number_last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  label: z.string().max(40).nullable(),
  total_charges_cents: z.number().int().nonnegative().max(100_000_000),
  taxes_fees_cents: z.number().int().nonnegative().max(10_000_000).nullable(),
  account_level_credits: z.array(ExtractedCreditSchema).default([]),
  lines: z.array(ExtractedLineSchema),
});
export type ExtractedAccount = z.infer<typeof ExtractedAccountSchema>;

// Overall extraction confidence. Optional + treated as 'high' when absent so
// fixtures and existing carrier normalizers do not have to be touched. When
// post-extraction sanity checks (e.g. totals reconciliation) flag the bill
// as suspect, the value is downgraded one tier (high→medium→low).
export const BillConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type BillConfidence = z.infer<typeof BillConfidenceSchema>;

export const ExtractedBillSchema = z.object({
  carrier: CarrierSchema,
  billing_period_start: z.string().date(),
  billing_period_end: z.string().date(),
  total_charges_cents: z.number().int().nonnegative().max(1_000_000_000),
  accounts: z.array(ExtractedAccountSchema).min(1),
  // (M-E1) Bound notes both per-string (500 chars covers any legitimate NTE
  // free-form note) and per-bill (50 entries — the runner persists `notes`
  // verbatim and any more is a smell that the LLM/EDI mapper went off the
  // rails). Defense-in-depth against log/storage bloat.
  notes: z.array(z.string().max(500)).max(50).default([]),
  confidence: BillConfidenceSchema.optional(),
});
export type ExtractedBill = z.infer<typeof ExtractedBillSchema>;

// Sentinel returned by the LLM when the document isn't a wireless bill.
export const NotABillSchema = z.object({
  error: z.literal('not_a_wireless_bill'),
});
