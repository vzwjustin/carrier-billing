import type { Rule, Finding } from '../types';
import { formatCents, isHotspotDevice } from '../helpers';

const RULE_ID = 'tablet_watch_with_zero_usage';

// Device-name patterns for non-phone connected devices that get their own
// cellular line. iPad, Galaxy Tab, Surface, Apple Watch, Galaxy Watch, Gizmo
// (Verizon kids' watch), Fitbit, Garmin, smartwatch are the most common.
// Phones are intentionally NOT in this list — they're handled by
// `zero_usage_phone_line`. Hotspots are excluded via `isHotspotDevice`.
const TABLET_WATCH_DEVICE_RE =
  /\b(ipad|tablet|\btab\b|surface|watch|smartwatch|gizmo|fitbit|garmin|wearable)\b/i;

/**
 * A tablet, smartwatch, or other connected accessory line that recorded zero
 * data AND zero voice this billing cycle. Distinct from:
 *  - `zero_usage_phone_line` — phones only (this rule explicitly catches the
 *    non-phone accessory category)
 *  - `unused_mifi_or_jetpack_line` — hotspot devices only
 *
 * Tablets and watches frequently end up on their own cellular line during
 * activation (carrier rep upsell), then get used over Wi-Fi exclusively.
 * Most carriers offer cheaper shared-data plans (Verizon NumberShare,
 * AT&T NumberSync, T-Mobile DIGITS) that pair the accessory to a primary
 * line for a few dollars a month — often a 50-70% reduction vs. the
 * standalone connected-device plan.
 *
 * SMS is intentionally NOT required to be zero: many tablets/watches don't
 * even report an SMS dimension, and a stray notification SMS shouldn't
 * suppress the finding.
 */
export const tabletWatchWithZeroUsageRule: Rule = {
  id: RULE_ID,
  title: 'Tablet or smartwatch line with zero data and voice usage',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (line.is_suspended) return;
        if (line.device === null) return;
        if (isHotspotDevice(line.device)) return;
        if (!TABLET_WATCH_DEVICE_RE.test(line.device)) return;

        // Require data + voice to be PRESENT and zero. Null means unknown,
        // not zero (see null-vs-zero discipline in zero_usage_phone_line).
        if (line.data_used_gb === null || line.voice_used_min === null) {
          return;
        }
        if (line.data_used_gb > 0) return;
        if (line.voice_used_min > 0) return;

        const planBase = line.plan_base_cents ?? 0;
        if (planBase <= 0) return;

        findings.push({
          rule_id: RULE_ID,
          severity: 'medium',
          title: `Connected device "${line.device}" used no data this cycle`,
          description: `This tablet/watch/wearable line recorded 0 GB of data and 0 voice minutes this period while still being charged ${formatCents(planBase)}/mo for its own cellular plan. Connected devices are commonly added at activation and then used exclusively over Wi-Fi.`,
          recommended_action:
            "Move this device onto the primary user's shared-data plan via the carrier's number-sharing feature (Verizon NumberShare, AT&T NumberSync, T-Mobile DIGITS) — typically a few dollars per month instead of a standalone plan. If the device is unused entirely, cancel the line.",
          estimated_monthly_savings_cents: planBase,
          // Strong signal (device-name class + dual zero usage) but cannot
          // rule out mid-cycle activation, so kept just inside "high
          // confidence" rather than at suspended_line_billed's 0.97.
          confidence: 0.85,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            device: line.device,
            plan_name: line.plan_name,
            plan_base_cents: planBase,
            data_used_gb: 0,
            voice_used_min: 0,
          },
        });
      });
    });

    return findings;
  },
};
