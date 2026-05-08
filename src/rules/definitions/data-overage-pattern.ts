import type { Rule, Finding } from '../types';

const RULE_ID = 'data_overage_pattern';

const HIGH_DATA_GB = 50;
const VERY_HIGH_DATA_GB = 100;
const HIGH_TIER_RE = /\b(pro|premium|plus|advanced|ultimate|elite)\b/i;

export const dataOveragePatternRule: Rule = {
  id: RULE_ID,
  title: 'Heavy data usage — review plan fit',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    // TODO(domain): map plan tier to soft cap; many "unlimited" plans
    // throttle at specific GB (Verizon Premium ~200GB, AT&T Premium ~100GB,
    // T-Mobile Ultimate ~50GB premium data + unlimited deprioritized).
    // Once the mapping is in place, flag lines approaching their actual cap
    // rather than the generic thresholds used today.
    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const used = line.data_used_gb ?? 0;

        // Branch A: very heavy use (>100 GB) on ANY plan — fires regardless
        // of plan tier. At this volume the line warrants a right-size review
        // independent of whether the current plan is "top tier".
        if (used > VERY_HIGH_DATA_GB) {
          findings.push({
            rule_id: RULE_ID,
            severity: 'info',
            title: `Very heavy data user — ${used.toFixed(0)} GB this period`,
            description: `This line used ${used.toFixed(2)} GB this period. At >${VERY_HIGH_DATA_GB} GB, the line is worth a right-size review regardless of current plan: confirm the plan's premium-data allotment isn't being exhausted and the line isn't being deprioritized.`,
            recommended_action:
              'Confirm this line is on the carrier\'s top-tier plan. If usage is stable at this volume, also evaluate whether a dedicated hotspot/router would be cheaper than tethering through a phone.',
            estimated_monthly_savings_cents: 0,
            confidence: 0.4,
            affected_line_indexes: [lineIndex],
            affected_account_indexes: [accountIndex],
            evidence: {
              plan_name: line.plan_name,
              data_used_gb: used,
              threshold_gb: VERY_HIGH_DATA_GB,
              branch: 'very_high_any_plan',
            },
          });
          return;
        }

        // Branch B: heavy use (>50 GB) on a top-tier plan — informational
        // monitoring finding.
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
            branch: 'heavy_top_tier',
          },
        });
      });
    });

    return findings;
  },
};
