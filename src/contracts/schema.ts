import { z } from 'zod';

import { CarrierSchema } from '@/extraction/schema';

/**
 * Schema for a single waived-fee entry inside `contract_terms.waived_fees`.
 * Stored as JSONB so a contract can waive any combination of named fees;
 * the rule layer only reads `name`, but `monthly_cents` lets the UI render
 * the saved $ amount when present.
 */
export const ContractWaivedFeeSchema = z.object({
  name: z.string().min(1).max(120),
  monthly_cents: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
});
export type ContractWaivedFee = z.infer<typeof ContractWaivedFeeSchema>;

/**
 * Extracted, normalized contract terms. Mirrors columns on
 * `public.contract_terms` 1:1. All fields are nullable so a partial
 * extraction can still persist what we got — the UI lets the user fill
 * in the rest via the PATCH route.
 */
export const ContractTermsSchema = z.object({
  plan_name: z.string().max(120).nullable(),
  contracted_monthly_rate_cents: z
    .number()
    .int()
    .nonnegative()
    .max(10_000_000)
    .nullable(),
  // Basis points: 12.5% = 1250. CHECK constraint at SQL layer enforces
  // 0..10000 — we mirror it in the schema for the same defense-in-depth
  // reason ExtractedCredit.monthly_cents has its <= 0 refinement.
  discount_percentage_bps: z.number().int().min(0).max(10_000).nullable(),
  waived_fees: z.array(ContractWaivedFeeSchema).max(50).nullable(),
  promo_credit_cents: z.number().int().nonnegative().max(1_000_000).nullable(),
  promo_duration_months: z.number().int().nonnegative().max(120).nullable(),
  // The next handful are free-text because contracts encode them in wildly
  // different ways. Bounded to 1000 chars each so an oversized payload
  // can't bloat the row or logs.
  device_credit_terms: z.string().max(1000).nullable(),
  line_minimums: z.number().int().nonnegative().max(1_000_000).nullable(),
  upgrade_fee_rules: z.string().max(1000).nullable(),
  activation_fee_rules: z.string().max(1000).nullable(),
  international_package_terms: z.string().max(1000).nullable(),
  early_termination_terms: z.string().max(1000).nullable(),
  notes: z.string().max(2000).nullable(),
});
export type ContractTerms = z.infer<typeof ContractTermsSchema>;

/**
 * The header fields the extractor pulls off the contract itself (carrier,
 * BAN-last4, effective/expiration dates). Separate from `ContractTerms`
 * because these live on the parent `contracts` row, not `contract_terms`.
 */
export const ContractHeaderSchema = z.object({
  carrier: CarrierSchema.nullable(),
  ban_last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  effective_date: z.string().date().nullable(),
  expiration_date: z.string().date().nullable(),
});
export type ContractHeader = z.infer<typeof ContractHeaderSchema>;

/**
 * Combined extractor output: what the LLM returns and what `extract.ts`
 * resolves to on success. Split into `header` + `terms` so the persistence
 * layer can write each piece to the right table.
 */
export const ExtractedContractSchema = z.object({
  header: ContractHeaderSchema,
  terms: ContractTermsSchema,
});
export type ExtractedContract = z.infer<typeof ExtractedContractSchema>;

/**
 * Shape passed to the rules engine via `RuleContext.contracts`. Joined
 * `contracts` + `contract_terms` rows for the audit's user. Carrier +
 * BAN-last4 are surfaced at the top level so a rule can carrier-scope its
 * match without re-parsing the nested terms.
 */
export type ContractWithTerms = {
  id: string;
  carrier: string | null;
  ban_last4: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  terms: ContractTerms | null;
};

/**
 * Sentinel returned by the LLM when the document isn't a carrier contract
 * or related quote/promo sheet — kept consistent with the bill extractor's
 * `not_a_wireless_bill` sentinel.
 */
export const NotAContractSchema = z.object({
  error: z.literal('not_a_contract'),
});
