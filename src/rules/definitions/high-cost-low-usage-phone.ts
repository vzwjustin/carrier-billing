import type { Rule, Finding } from '../types';
import { formatCents, isHotspotDevice } from '../helpers';

const RULE_ID = 'high_cost_low_usage_phone';

// $75/mo plan_base is the boundary above which a line is paying premium-tier
// money. Common Verizon Business Unlimited Pro 2.0, AT&T Business Unlimited
// Premium, and T-Mobile Business Unlimited Ultimate+ all land at or above
// this number after typical line-count discounts.
const HIGH_PLAN_BASE_CENTS = 7500;
// Usage thresholds that together define "low usage". All three must be both
// reported (non-null) AND below threshold to fire. Premium plans bundle
// unlimited everything, so under-2GB / under-30-min / under-30-SMS lines
// are extracting essentially none of the bundle's value — a mid-tier plan
// would cover the same usage at roughly $20-30/mo less.
const LOW_DATA_GB = 2;
const LOW_VOICE_MIN = 30;
const LOW_SMS_COUNT = 30;
// Per-line savings estimate when right-sizing from premium → mid-tier on
// the major business stacks. $20/mo is the conservative end of the typical
// $20-30 delta — better to under-claim than to over-claim.
const ESTIMATED_DOWNGRADE_SAVINGS_CENTS = 2000;

/**
 * An active, non-suspended, non-hotspot phone line paying ≥$75/mo plan base
 * that's recording trivial usage across all three dimensions (data, voice,
 * SMS). Distinct from:
 *  - `zero_usage_phone_line` — that requires literally zero across all
 *    three; this catches the "barely-used" tier.
 *  - `underutilized_phone_on_premium_plan` — that fires on premium plan
 *    NAMES specifically; this fires on the dollar-amount signal regardless
 *    of plan name (catches off-tier exec/grandfathered SKUs).
 *
 * Recommendation is a plan downgrade rather than a cancellation — there IS
 * some usage, so the line is in service, just on more plan than it needs.
 *
 * Confidence 0.7 ("Likely" bucket per types.ts). Three independent low
 * signals plus a clear dollar trigger is a strong pattern, but cannot rule
 * out a "this line is a backup / on-call" use case where the carrier still
 * needs to be on a guaranteed-quality tier.
 */
export const highCostLowUsagePhoneRule: Rule = {
  id: RULE_ID,
  title: 'Premium-priced phone line with very low usage across the cycle',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (line.is_suspended) return;
        if (isHotspotDevice(line.device)) return;

        const planBase = line.plan_base_cents ?? 0;
        if (planBase < HIGH_PLAN_BASE_CENTS) return;

        // All three usage signals must be PRESENT and below threshold.
        // Null = unknown, not low (see null-vs-zero discipline in
        // `zero_usage_phone_line`).
        if (
          line.data_used_gb === null ||
          line.voice_used_min === null ||
          line.sms_used_count === null
        ) {
          return;
        }
        if (line.data_used_gb >= LOW_DATA_GB) return;
        if (line.voice_used_min >= LOW_VOICE_MIN) return;
        if (line.sms_used_count >= LOW_SMS_COUNT) return;

        findings.push({
          rule_id: RULE_ID,
          severity: 'low',
          title: `Premium plan (${formatCents(planBase)}/mo) used barely at all`,
          description: `This active phone line is on a premium-tier plan at ${formatCents(planBase)}/mo but used only ${line.data_used_gb} GB of data, ${line.voice_used_min} voice minutes, and ${line.sms_used_count} SMS this cycle — far below the thresholds where the unlimited bundle starts paying off. A mid-tier business plan would cover this usage at materially less, with the option to upgrade back if usage grows.`,
          recommended_action:
            'Move this line to a mid-tier business unlimited plan (Verizon Business Unlimited Plus 2.0, AT&T Business Unlimited Performance, T-Mobile Business Unlimited Advanced). Estimated savings of ~$20/mo, with the option to upgrade back if usage grows.',
          estimated_monthly_savings_cents: ESTIMATED_DOWNGRADE_SAVINGS_CENTS,
          // "Likely" bucket per types.ts (≤ 0.8). Three usage signals + dollar
          // gate is strong, but the on-call/backup-line edge keeps it below
          // the "high confidence" bucket.
          confidence: 0.7,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
            plan_base_cents: planBase,
            data_used_gb: line.data_used_gb,
            voice_used_min: line.voice_used_min,
            sms_used_count: line.sms_used_count,
            data_threshold_gb: LOW_DATA_GB,
            voice_threshold_min: LOW_VOICE_MIN,
            sms_threshold_count: LOW_SMS_COUNT,
            plan_base_threshold_cents: HIGH_PLAN_BASE_CENTS,
          },
        });
      });
    });

    return findings;
  },
};
