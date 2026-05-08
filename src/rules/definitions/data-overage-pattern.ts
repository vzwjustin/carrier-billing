import type { Rule, Finding, Severity } from '../types';

const RULE_ID = 'data_overage_pattern';

const HIGH_DATA_GB = 50;
const VERY_HIGH_DATA_GB = 100;
const HIGH_TIER_RE = /\b(pro|premium|plus|advanced|ultimate|elite)\b/i;
const SOFT_CAP_WARN_RATIO = 0.8;

// Published premium-data / deprioritization thresholds for current US business
// unlimited tiers. Conservative values — when a tier's published threshold is
// a range, we use the lower bound to bias against false positives.
// Verifying public docs as of 2026-05; substring-matched on plan_name.
const PLAN_SOFT_CAPS_GB: Array<{ pattern: RegExp; threshold_gb: number }> = [
  // Verizon Business Unlimited 2.0 family
  { pattern: /business\s+unlimited\s+pro\s*2\.0/i, threshold_gb: 200 },
  { pattern: /business\s+unlimited\s+plus\s*2\.0/i, threshold_gb: 100 },
  { pattern: /business\s+unlimited\s+start\s*2\.0/i, threshold_gb: 50 },
  // AT&T Business Unlimited family
  { pattern: /business\s+unlimited\s+premium/i, threshold_gb: 100 },
  { pattern: /business\s+unlimited\s+performance/i, threshold_gb: 50 },
  { pattern: /business\s+unlimited\s+starter/i, threshold_gb: 22 },
  // T-Mobile for Business family
  { pattern: /business\s+unlimited\s+ultimate/i, threshold_gb: 100 },
  { pattern: /business\s+unlimited\s+advanced/i, threshold_gb: 100 },
  { pattern: /business\s+unlimited\s+select/i, threshold_gb: 50 },
];

function findSoftCap(planName: string | null): number | null {
  if (planName === null) return null;
  for (const { pattern, threshold_gb } of PLAN_SOFT_CAPS_GB) {
    if (pattern.test(planName)) return threshold_gb;
  }
  return null;
}

export const dataOveragePatternRule: Rule = {
  id: RULE_ID,
  title: 'Heavy data usage — review plan fit',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const used = line.data_used_gb ?? 0;
        const softCap = findSoftCap(line.plan_name);

        // Branch S: known soft cap match — uses the actual per-tier threshold
        // from PLAN_SOFT_CAPS_GB rather than the generic 50/100 fallbacks.
        // This is authoritative when matched; skip the generic branches.
        if (softCap !== null) {
          const ratio = used / softCap;
          if (ratio < SOFT_CAP_WARN_RATIO) return;

          const exceeded = used > softCap;
          const severity: Severity = exceeded ? 'low' : 'low';
          const title = exceeded
            ? `Line over soft cap on "${line.plan_name}" — ${used.toFixed(0)}/${softCap} GB`
            : `Line approaching soft cap on "${line.plan_name}" — ${used.toFixed(0)}/${softCap} GB`;
          const description = exceeded
            ? `This line used ${used.toFixed(2)} GB this period, above the ~${softCap} GB premium-data threshold for "${line.plan_name}". Past the cap, the carrier deprioritizes the line during congestion.`
            : `This line used ${used.toFixed(2)} GB this period, ${(ratio * 100).toFixed(0)}% of the ~${softCap} GB premium-data threshold for "${line.plan_name}". If usage continues to climb, the line will be deprioritized during congestion.`;
          const recommended_action = exceeded
            ? `Move this line to a higher-tier plan with a larger or unlimited premium-data allotment, or split heavy use to a dedicated hotspot/router.`
            : `Monitor next 1-2 cycles. If usage continues at this level, evaluate the next tier above "${line.plan_name}" or move heavy traffic to a dedicated hotspot.`;

          findings.push({
            rule_id: RULE_ID,
            severity,
            title,
            description,
            recommended_action,
            estimated_monthly_savings_cents: 0,
            confidence: 0.7,
            affected_line_indexes: [lineIndex],
            affected_account_indexes: [accountIndex],
            evidence: {
              plan_name: line.plan_name,
              data_used_gb: used,
              threshold_gb: softCap,
              utilization_ratio: Number(ratio.toFixed(2)),
              branch: exceeded ? 'over_soft_cap' : 'approaching_soft_cap',
            },
          });
          return;
        }

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
