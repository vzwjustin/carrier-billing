import type { Carrier, ExtractedBill } from '@/extraction/schema';

/**
 * Confidence Buckets
 * ------------------
 * `Confidence` values across rules are intentionally COMPARABLE. Rule
 * authors should treat the following thresholds as the canonical buckets;
 * the same thresholds drive the human-readable label used in the report
 * UI (see `src/reports/finding-view-model.ts:confidenceLabel`).
 *
 *   confidence  < 0.5   →  Speculative
 *   confidence ≤ 0.8    →  Likely
 *   confidence  > 0.8   →  High confidence
 *
 * If you find yourself emitting a confidence whose bucket doesn't match
 * your intent, raise the bucket boundaries or change your rule — DO NOT
 * pick an off-bucket number to game the badge. Cross-rule consistency is
 * the whole point of using a shared scale.
 */

/**
 * Severity ranking for a finding. Drives sorting + UI badges.
 *  - 'high'   actionable now, real $ on the table
 *  - 'medium' actionable soon, smaller $ or some uncertainty
 *  - 'low'    likely worth a glance, low confidence or low $
 *  - 'info'   purely informational; no recommended action
 */
export type Severity = 'high' | 'medium' | 'low' | 'info';

/**
 * Reviewer workflow status on a persisted finding (migration 0023). Lives
 * here so both the API route and UI components can import without dragging
 * a 'use client' boundary in. Mirrors the CHECK constraint in
 * `supabase/migrations/0023_finding_status_workflow.sql` — keep in sync.
 */
export type FindingStatus =
  | 'new'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'disputed'
  | 'resolved';

/**
 * A confidence number constrained to [0, 1]. Kept as `number` (not branded)
 * so rule authors don't have to plumb a constructor through every helper.
 * Validated at the rule-runner layer. See "Confidence Buckets" above for
 * the comparable-scale convention.
 */
export type Confidence = number;

export type Finding = {
  /**
   * Database row id. Optional because the rule engine itself does not know
   * the id — it's assigned by the persistence layer. The report builder
   * populates it when reconstructing a Finding from a `ReportFindingRow`
   * so UI components can pass it back into the reviewer-status API.
   */
  id?: string;
  rule_id: string;
  severity: Severity;
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number;
  /** 0.0 - 1.0; values outside this range are clamped by the runner. */
  confidence: Confidence;
  /**
   * 0-based positions inside `accounts[<this account>].lines[]` (per-account
   * scoped). The worker translates these to global indexes before persistence
   * (see `process-bill.ts:translateLineIndexes`). Rules MUST emit local
   * indexes.
   */
  affected_line_indexes: number[];
  /** 0-based positions inside ctx.bill.accounts[]. */
  affected_account_indexes: number[];
  /** Small, PII-free JSON describing what triggered the finding. */
  evidence: Record<string, unknown>;
  /**
   * Reviewer workflow status. Optional for the same reason as `id` —
   * the rule engine doesn't set it; the persistence layer + builder do.
   */
  status?: FindingStatus;
};

export type RuleContext = {
  bill: ExtractedBill;
  /** Always inject "now" — never call `new Date()` inside a rule. */
  today: Date;
  carrier: Carrier;
};

export type Rule = {
  /** Stable, snake_case id; matches the filename. */
  id: string;
  /** Human-readable name of the rule itself (not the finding). */
  title: string;
  appliesTo: Carrier[] | 'all';
  evaluate: (ctx: RuleContext) => Finding[] | Promise<Finding[]>;
};
