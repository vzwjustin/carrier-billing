import type { Rule, Finding } from '../types';

const RULE_ID = 'data_overage_pattern';

const HIGH_DATA_GB = 50;
const HIGH_TIER_RE = /\b(pro|premium|plus|advanced|ultimate|elite)\b/i;

export const dataOveragePatternRule: Rule = {
  id: RULE_ID,
  title: 'Heavy data usage — review plan fit',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    // TODO(domain): connect plan tiers to thresholds. Carriers throttle/depri
    // at different points (Verizon Premium: 200GB; AT&T Premium: 100GB; etc).
    // Justin to map plan_name → soft cap so we can flag lines approaching
    // their cap, not just any line above an arbitrary threshold.
    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const used = line.data_used_gb ?? 0;
        if (used <= HIGH_DATA_GB) return;
        if (!line.plan_name) return;
        if (!HIGH_TIER_RE.test(line.plan_name)) return;

        findings.push({
          rule_id: RULE_ID,
          severity: 'info',
          title: `Heavy data user on plan "${line.plan_name}"`,
          description: `This line used ${used.toFixed(2)} GB this period. Heavy users on top-tier plans are usually correctly placed, but this line is worth monitoring against the plan's deprioritization threshold.`,
          recommended_action:
            'Track this line over 2-3 billing periods. If usage consistently approaches the plan’s deprioritization cap, confirm there’s no tier above it that would be a better fit.',
          estimated_monthly_savings_cents: 0,
          confidence: 0.4,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
            data_used_gb: used,
            threshold_gb: HIGH_DATA_GB,
          },
        });
      });
    });

    return findings;
  },
};
