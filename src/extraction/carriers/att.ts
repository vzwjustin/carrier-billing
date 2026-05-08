import type { ExtractedBill } from '@/extraction/schema';

/**
 * AT&T-specific normalization pass over an LLM-extracted bill.
 * Phase 1 leans on the LLM for normalization; this is a pass-through.
 *
 * TODO(domain): carrier-specific normalization (e.g., feature name
 * canonicalization for AT&T Business Unlimited tiers) — Justin to define.
 */
export function normalize(bill: ExtractedBill): ExtractedBill {
  return bill;
}
