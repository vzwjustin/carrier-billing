import type { Rule, Finding } from '../types';
import { formatCents, isHotspotDevice } from '../helpers';

const RULE_ID = 'underutilized_phone_on_premium_plan';

// Heuristic: a phone line on a top-tier plan with negligible voice + data
// is paying the premium tier price for a usage profile a starter tier would
// cover. Excluded: hotspots (covered by `unused_mifi_or_jetpack_line`),
// suspended lines (covered by `suspended_line_billed`), and lines where we
// don't have usage data (treating null as 0 would over-flag carriers that
// don't always report per-line usage).
const PREMIUM_TIER_RE = /\b(pro|premium|plus|advanced|ultimate|elite)\b/i;
const LOW_DATA_GB = 5;
const LOW_VOICE_MIN = 60;
// Conservative savings: $10/mo per line moving from a premium to mid tier.
const ESTIMATED_SAVINGS_CENTS = 1000;

export const underutilizedPhoneOnPremiumPlanRule: Rule = {
  id: RULE_ID,
  title: 'Underutilized line on premium-tier plan',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (line.is_suspended) return;
        if (isHotspotDevice(line.device)) return;
        if (line.plan_name === null) return;
        if (!PREMIUM_TIER_RE.test(line.plan_name)) return;
        // Require BOTH usage signals to reduce false positives — a line with
        // unrecorded voice but high data should not fire.
        if (line.data_used_gb === null || line.voice_used_min === null) return;
        if (line.data_used_gb >= LOW_DATA_GB) return;
        if (line.voice_used_min >= LOW_VOICE_MIN) return;

        const planBase = line.plan_base_cents ?? 0;
        findings.push({
          rule_id: RULE_ID,
          severity: 'low',
          title: `Line on "${line.plan_name}" used very little this period`,
          description: `This line is on the premium-tier plan "${line.plan_name}" (${formatCents(planBase)}/mo) but consumed only ${line.data_used_gb.toFixed(2)} GB of data and ${line.voice_used_min} voice minutes. Premium-tier perks (premium streaming, hotspot allotment, international) may not be exercised — a mid-tier plan would likely cover the actual usage at a lower rate.`,
          recommended_action: `Track usage over 2 cycles. If the line consistently stays below ${LOW_DATA_GB} GB / ${LOW_VOICE_MIN} min, evaluate moving it to a mid-tier plan. Conservative per-line savings estimate: ${formatCents(ESTIMATED_SAVINGS_CENTS)}/mo.`,
          estimated_monthly_savings_cents: ESTIMATED_SAVINGS_CENTS,
          confidence: 0.55,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
            plan_base_cents: planBase,
            data_used_gb: line.data_used_gb,
            voice_used_min: line.voice_used_min,
          },
        });
      });
    });

    return findings;
  },
};
