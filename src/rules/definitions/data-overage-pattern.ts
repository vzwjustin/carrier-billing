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
  // M4: Verizon Business Unlimited Pro 2.0 no longer has a premium-data soft
  // cap — the tier is "no cap; deprioritization on congestion only" per
  // Verizon's 2024 announcement. Listing a 200 GB cap here previously fired
  // "approaching soft cap" findings recommending users move up to a
  // non-existent higher tier. The line still surfaces via Branch A
  // (very_high_any_plan) at >100 GB if real review is warranted.
  // Pro 2.0 intentionally absent.
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
        // M5: null-vs-zero discipline. A null data_used_gb means the carrier
        // never reported usage for this line — NOT that the line used 0 GB.
        // Coercing null→0 silently suppresses any overage finding on a line
        // whose usage failed extraction (false-negative). Skip the line,
        // matching zero-usage-phone-line.ts / unused-mifi-line.ts.
        if (line.data_used_gb === null) return;
        const used = line.data_used_gb;
        const softCap = findSoftCap(line.plan_name);

        // Branch S: known soft cap match — uses the actual per-tier threshold
        // from PLAN_SOFT_CAPS_GB rather than the generic 50/100 fallbacks.
        // This is authoritative when matched; skip the generic branches.
        // Guard `softCap > 0`: a zero soft-cap would mean "no premium-data
        // allotment" (effectively no cap) and dividing by it would yield
        // Infinity / NaN. Treat 0 as "no soft-cap data" and skip the
        // warn-ratio branch entirely.
        if (softCap !== null && softCap > 0) {
          const ratio = used / softCap;
          if (ratio < SOFT_CAP_WARN_RATIO) return;

          const exceeded = used > softCap;
          const severity: Severity = exceeded ? 'medium' : 'low';
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
              "Confirm this line is on the carrier's top-tier plan. If usage is stable at this volume, also evaluate whether a dedicated hotspot/router would be cheaper than tethering through a phone.",
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

        // Branches B & C cover the 50..100 GB band when no soft cap matched.
        if (used <= HIGH_DATA_GB) return;

        const isTopTier = line.plan_name !== null && HIGH_TIER_RE.test(line.plan_name);

        if (isTopTier) {
          // Branch B: heavy use (>50 GB) on a top-tier plan — informational
          // monitoring finding. Likely correctly placed; flag for trend watch.
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
          return;
        }

        // Branch C: heavy use (>50 GB, ≤100 GB) on a non-top-tier plan with
        // no recognized soft cap — closes the previous coverage hole where a
        // mid-tier or unknown plan at 75 GB produced no finding at all. Lower
        // confidence than the soft-cap branch because we don't know the
        // exact deprioritization threshold for this plan.
        findings.push({
          rule_id: RULE_ID,
          severity: 'info',
          title: line.plan_name
            ? `Heavy data use on non-top-tier plan "${line.plan_name}"`
            : `Heavy data use — ${used.toFixed(0)} GB this period`,
          description: `This line used ${used.toFixed(2)} GB this period on ${line.plan_name ? `"${line.plan_name}"` : 'an unrecognized plan'}. Lines pushing past ${HIGH_DATA_GB} GB on a non-top-tier plan often hit the carrier's deprioritization threshold during congestion. Worth a tier-fit review.`,
          recommended_action:
            "Confirm the line's plan is the right tier for sustained heavy use. If usage stays at this volume, evaluate moving up a tier (or moving heavy traffic to a dedicated hotspot/router).",
          estimated_monthly_savings_cents: 0,
          confidence: 0.35,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
            data_used_gb: used,
            threshold_gb: HIGH_DATA_GB,
            branch: 'heavy_non_top_tier',
          },
        });
      });
    });

    return findings;
  },
};
