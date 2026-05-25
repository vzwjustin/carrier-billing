import type { Rule, Finding } from '../types';
import { isHotspotDevice } from '../helpers';

const RULE_ID = 'unassigned_user_label';

// Device names that legitimately have no human owner — these are pooled
// connectivity devices (in-vehicle modems, fleet routers, IoT gateways) or
// MiFi hotspots. The `isHotspotDevice` helper covers Jetpack / MiFi /
// Inseego / Nighthawk; this regex layers on the router/modem/IoT class.
const SHARED_DEVICE_RE =
  /\b(router|modem|gateway|cradlepoint|peplink|sensor|iot|m2m|gps|telematics)\b/i;
// Fraction of OTHER lines on the account that must carry a user_label before
// we treat "label missing" as actionable on this specific line. Below this,
// it's almost certainly an account that just doesn't use the labeling field
// rather than a forgotten attribution.
const PEER_LABEL_FRACTION = 0.5;
// Need at least this many other lines with labels before we can talk about
// "the rest of the account is labeled". Snapshot fixture has 0 labeled
// lines and so cannot satisfy this gate — by design.
const MIN_LABELED_PEERS = 2;

/**
 * A line with a non-null device and non-null plan but no user_label, where
 * at least half of the OTHER lines on the same account DO have labels. The
 * "peer labels" gate is what distinguishes this from "this account just
 * doesn't use the labeling field" — when ≥50% of peers are labeled, the
 * unlabeled line is the outlier worth chasing in the customer's TEM tool.
 *
 * Pooled / shared-device classes (routers, modems, IoT gateways, MiFi
 * hotspots) are excluded — they legitimately have no human owner.
 *
 * Info-severity / 0.7 confidence: this is a TEM-hygiene finding, not a
 * dollar-saving finding. Estimated savings is 0.
 */
export const unassignedUserLabelRule: Rule = {
  id: RULE_ID,
  title: 'Line is unlabeled in a fleet that otherwise tags every line',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      const peerHasLabel = account.lines.map(
        (line) =>
          line.user_label !== null && line.user_label.trim().length > 0,
      );
      const labeledCount = peerHasLabel.filter(Boolean).length;
      if (labeledCount < MIN_LABELED_PEERS) return;

      account.lines.forEach((line, lineIndex) => {
        if (line.user_label !== null && line.user_label.trim().length > 0) {
          return;
        }
        if (line.device === null) return;
        if (line.plan_name === null) return;
        if (isHotspotDevice(line.device)) return;
        if (SHARED_DEVICE_RE.test(line.device)) return;

        // Compute the fraction of OTHER lines on the same account that have
        // a label. If the rest of the account is mostly labeled, this single
        // missing label is structurally interesting.
        const otherCount = account.lines.length - 1;
        if (otherCount <= 0) return;
        const otherLabeled = labeledCount - (peerHasLabel[lineIndex] ? 1 : 0);
        const fraction = otherLabeled / otherCount;
        if (fraction < PEER_LABEL_FRACTION) return;

        findings.push({
          rule_id: RULE_ID,
          severity: 'info',
          title: `Line has no user assignment on a fleet that otherwise tags everyone`,
          description: `This line has a device ("${line.device}") and an active plan ("${line.plan_name}") but no user_label, while ${otherLabeled} of ${otherCount} other lines on the same account ARE labeled. Unattributed lines are the most common source of zombie spend — without an owner there's nobody to verify the line is still in use.`,
          recommended_action:
            'Look up this MDN in your TEM tool (or call the carrier with the device IMEI/SIM ICCID) to identify the owner. If no current employee owns the line, run it through your standard line-decommission process.',
          // TEM-hygiene finding. Zero monthly savings is correct; the
          // downstream investigation may surface a real saving (cancel the
          // line) but that's a different rule's job.
          estimated_monthly_savings_cents: 0,
          // "Likely" bucket per types.ts (≤ 0.8). Pattern is structural but
          // we can't tell from the bill whether the line is actually unused
          // — that's the investigation this rule prompts.
          confidence: 0.7,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            device: line.device,
            plan_name: line.plan_name,
            other_lines_labeled: otherLabeled,
            other_lines_total: otherCount,
            labeled_fraction: Number(fraction.toFixed(2)),
          },
        });
      });
    });

    return findings;
  },
};
