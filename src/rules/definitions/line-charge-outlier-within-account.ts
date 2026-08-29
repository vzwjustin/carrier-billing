import type { Rule, Finding } from '../types';
import type { ExtractedLine } from '@/extraction/schema';
import { formatCents, isHotspotDevice } from '../helpers';

const RULE_ID = 'line_charge_outlier_within_account';

// Multiplier above the within-account median that classifies a phone line as
// an outlier. 2× is conservative — a fleet where everyone's on the same plan
// will have a tight median, so 2× catches genuinely outsized lines without
// flagging routine variation (e.g. a single international add-on or extra
// 50GB hotspot SOC won't double the line cost).
const OUTLIER_MULTIPLE = 2;
// Need at least this many comparable peer lines to compute a meaningful
// median. With fewer, "median of the rest" is too sensitive to a single
// expensive line. 3 peers => 4+ phone lines on the account.
const MIN_PEER_LINES = 3;

// Device-name patterns we treat as non-phone connected devices. We exclude
// these from the peer set AND from outlier candidacy — they're priced on
// their own connected-device pricing curves (cheaper) and have separate rules
// (`tablet_watch_with_zero_usage`, `unused_mifi_or_jetpack_line`).
const NON_PHONE_DEVICE_RE =
  /\b(ipad|tablet|\btab\b|surface|watch|smartwatch|gizmo|fitbit|garmin|wearable)\b/i;

function isPhoneLine(line: ExtractedLine): boolean {
  if (line.is_suspended) return false;
  if (line.device !== null && isHotspotDevice(line.device)) return false;
  if (line.device !== null && NON_PHONE_DEVICE_RE.test(line.device)) return false;
  return true;
}

function lineMonthlyCost(line: ExtractedLine): number {
  const planBase = line.plan_base_cents ?? 0;
  const features = line.features.reduce((sum, f) => sum + f.monthly_cents, 0);
  return planBase + features;
}

// ⚡ Bolt: Calculates the median of a sorted array excluding a single occurrence of `excludeValue`
function getMedianExcluding(sorted: number[], excludeValue: number): number {
  const n = sorted.length;
  if (n <= 1) return 0;

  // Binary search to find the index of the element to exclude
  let left = 0;
  let right = n - 1;
  let excludeIdx = -1;
  while (left <= right) {
    const mid = left + Math.floor((right - left) / 2);
    if (sorted[mid] === excludeValue) {
      excludeIdx = mid;
      // If there are duplicates, we just need to exclude one of them,
      // we continue searching left to find the first occurrence just for consistency
      right = mid - 1;
    } else if (sorted[mid] < excludeValue) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  if (excludeIdx === -1) {
    // Fallback if not found, shouldn't happen based on usage
    excludeIdx = 0;
  }

  // Virtual array accessor that skips `excludeIdx`
  const getVal = (i: number) => (i < excludeIdx ? sorted[i] : sorted[i + 1]);
  const count = n - 1;
  const mid = Math.floor(count / 2);

  if (count % 2 === 1) {
    return getVal(mid) ?? 0;
  }
  return ((getVal(mid - 1) ?? 0) + (getVal(mid) ?? 0)) / 2;
}

/**
 * Per-account outlier detector: flags any phone line whose
 * (plan_base + sum(features)) is at least 2× the median of OTHER phone lines
 * on the same account. Hotspots, tablets/watches/wearables and suspended
 * lines are excluded from both candidacy and the peer set — they have their
 * own pricing curves and dedicated rules.
 *
 * Requires at least MIN_PEER_LINES other phone lines (so 4+ phone lines on
 * the account). With smaller peer groups "median of the rest" becomes
 * meaningless. The snapshot fixture has 2 lines total and therefore does NOT
 * fire this rule — by design.
 */
export const lineChargeOutlierWithinAccountRule: Rule = {
  id: RULE_ID,
  title: 'Phone line costs noticeably more than peers on the same account',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      const phones = account.lines
        .map((line, lineIndex) => ({ line, lineIndex }))
        .filter(({ line }) => isPhoneLine(line));

      if (phones.length < MIN_PEER_LINES + 1) return;

      // ⚡ Bolt: Pre-compute all sorted costs to avoid O(N^2 log N) nested sorting and intermediate array allocations
      const allCosts = phones.map((p) => lineMonthlyCost(p.line)).sort((a, b) => a - b);

      for (const { line, lineIndex } of phones) {
        const cost = lineMonthlyCost(line);
        if (cost <= 0) continue;

        // Exclude this line's cost from the sorted array
        const med = getMedianExcluding(allCosts, cost);
        if (med <= 0) continue;

        if (cost < OUTLIER_MULTIPLE * med) continue;

        const excess = cost - med;

        findings.push({
          rule_id: RULE_ID,
          severity: 'medium',
          title: `Line costs ${formatCents(cost)}/mo vs ${formatCents(med)} median across peer lines`,
          description: `This phone line costs ${formatCents(cost)}/mo (plan + features) while the median for other phone lines on this account is ${formatCents(med)}/mo. A 2× gap typically points to a richer plan tier or stacked add-ons that don't match the rest of the fleet — sometimes a legitimate executive line, sometimes a forgotten upgrade or a SOC stack that drifted from the standard.`,
          recommended_action:
            "Compare this line's plan tier and feature list against a typical peer line on the same account. If the upgrade is intentional, document why; if not, ask your carrier rep to right-size the plan or remove the extra add-ons.",
          // Down-to-median is a reasonable upper bound on what's recoverable
          // by realigning the line to the fleet standard.
          estimated_monthly_savings_cents: excess,
          // "Likely" bucket per types.ts. The pattern is structural and
          // statistically grounded, but we cannot distinguish a justifiable
          // exec line from drift without human input.
          confidence: 0.65,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            line_cost_cents: cost,
            peer_median_cents: med,
            multiple: Number((cost / med).toFixed(2)),
            peer_count: phones.length - 1,
            plan_name: line.plan_name,
          },
        });
      }
    });

    return findings;
  },
};
