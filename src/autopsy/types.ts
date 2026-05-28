/**
 * Bill Increase Autopsy — public types.
 *
 * The autopsy engine consumes two `ExtractedBill` snapshots (previous +
 * current) and produces a categorized breakdown of what changed and why.
 * It is intentionally a **pure** transformation: no I/O, no time, no env.
 * Persistence happens in the API/inngest layer.
 *
 * Anchor for the spec: SignalAudit "Bill Increase Autopsy" §"Required
 * change categories" and §"Bill Increase Autopsy rules".
 */

export const CHANGE_CATEGORIES = [
  'new_lines',
  'removed_lines',
  'plan_changes',
  'device_installments_added',
  'device_installments_removed',
  'missing_credits',
  'new_credits',
  'credits_decreased',
  'credits_increased',
  'one_time_charges',
  'activation_fees',
  'insurance_changes',
  'international_charges',
  'roaming_charges',
  'overage_charges',
  'taxes_fees_change',
  'feature_addon_changes',
  'suspended_line_still_billed',
  'unexplained',
] as const;

export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

/**
 * One categorized cause of the bill change. `difference_cents` is signed
 * (positive = bill went up because of this driver, negative = bill went
 * down). The engine emits at most one driver per category; per-line
 * detail lives in `evidence.lines`.
 */
export interface ChangeDriver {
  category: ChangeCategory;
  title: string;
  summary: string;
  previous_cents: number;
  current_cents: number;
  difference_cents: number;
  affected_lines_count: number;
  confidence: number;
  is_disputable: boolean;
  is_optimization: boolean;
  is_unexplained: boolean;
  recommended_action: string | null;
  evidence: ChangeDriverEvidence;
}

/**
 * PII-disciplined evidence payload. We never emit full MDNs — only the
 * last-4 already present on `ExtractedLine.mdn_last4`. `lines` keys by
 * (account_last4, mdn_last4) so the UI can deduplicate.
 */
export interface ChangeDriverEvidence {
  /** Per-line contribution to this driver. */
  lines?: Array<{
    account_last4: string | null;
    mdn_last4: string | null;
    user_label: string | null;
    previous_cents: number;
    current_cents: number;
    difference_cents: number;
    note?: string;
  }>;
  /** Account-level contribution (no specific line). */
  accounts?: Array<{
    account_last4: string | null;
    previous_cents: number;
    current_cents: number;
    difference_cents: number;
    note?: string;
  }>;
  /** Free-form notes the engine wants to surface (e.g. "5 of 11 had names matching 'Promo')"). */
  notes?: string[];
}

export interface AutopsyResult {
  previous_total_cents: number;
  current_total_cents: number;
  net_change_cents: number;
  /** Net change as basis points of previous total; null if previous total is 0. */
  percent_change_bps: number | null;
  disputable_cents: number;
  optimization_cents: number;
  unexplained_cents: number;
  executive_summary: string;
  drivers: ChangeDriver[];
  metadata: {
    engine_version: string;
    drivers_by_category: Partial<Record<ChangeCategory, number>>;
    /** Total of all driver.difference_cents — useful for the unexplained residual. */
    drivers_sum_cents: number;
  };
}
