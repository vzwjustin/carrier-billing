import { z } from 'zod';

// Carriers we support. Anything we can't classify is 'unknown'.
export const CarrierSchema = z.enum(['verizon', 'att', 'tmobile', 'unknown']);
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
  name: z.string().min(1),
  category: FeatureCategorySchema.default('other'),
  monthly_cents: z.number().int().nonnegative(),
});
export type ExtractedFeature = z.infer<typeof ExtractedFeatureSchema>;

export const ExtractedCreditSchema = z.object({
  name: z.string().min(1),
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

export const ExtractedDppSchema = z.object({
  device: z.string().min(1),
  monthly_cents: z.number().int().nonnegative(),
  remaining_payments: z.number().int().nonnegative().nullable(),
  total_payments: z.number().int().positive().nullable(),
});
export type ExtractedDpp = z.infer<typeof ExtractedDppSchema>;

export const ExtractedLineSchema = z.object({
  mdn_last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  user_label: z.string().nullable(),
  device: z.string().nullable(),
  plan_name: z.string().nullable(),
  plan_base_cents: z.number().int().nonnegative().nullable(),
  data_used_gb: z.number().nonnegative().nullable(),
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
  label: z.string().nullable(),
  total_charges_cents: z.number().int().nonnegative(),
  taxes_fees_cents: z.number().int().nonnegative().nullable(),
  account_level_credits: z.array(ExtractedCreditSchema).default([]),
  lines: z.array(ExtractedLineSchema),
});
export type ExtractedAccount = z.infer<typeof ExtractedAccountSchema>;

export const ExtractedBillSchema = z.object({
  carrier: CarrierSchema,
  billing_period_start: z.string().date(),
  billing_period_end: z.string().date(),
  total_charges_cents: z.number().int().nonnegative(),
  accounts: z.array(ExtractedAccountSchema).min(1),
  notes: z.array(z.string()).default([]),
});
export type ExtractedBill = z.infer<typeof ExtractedBillSchema>;

// Sentinel returned by the LLM when the document isn't a wireless bill.
export const NotABillSchema = z.object({
  error: z.literal('not_a_wireless_bill'),
});
