import type { Carrier, ExtractedBill } from '@/extraction/schema';

/**
 * Severity ranking for a finding. Drives sorting + UI badges.
 *  - 'high'   actionable now, real $ on the table
 *  - 'medium' actionable soon, smaller $ or some uncertainty
 *  - 'low'    likely worth a glance, low confidence or low $
 *  - 'info'   purely informational; no recommended action
 */
export type Severity = 'high' | 'medium' | 'low' | 'info';

/**
 * A confidence number constrained to [0, 1]. Kept as `number` (not branded)
 * so rule authors don't have to plumb a constructor through every helper.
 * Validated at the rule-runner layer.
 */
export type Confidence = number;

export type Finding = {
  rule_id: string;
  severity: Severity;
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number;
  /** 0.0 - 1.0; values outside this range are clamped by the runner. */
  confidence: Confidence;
  /** 0-based positions inside the flattened ctx.bill.accounts[].lines[]. */
  affected_line_indexes: number[];
  /** 0-based positions inside ctx.bill.accounts[]. */
  affected_account_indexes: number[];
  /** Small, PII-free JSON describing what triggered the finding. */
  evidence: Record<string, unknown>;
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
