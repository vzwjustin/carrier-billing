import type { Rule, Finding } from '../types';
import { formatCents, isHotspotDevice } from '../helpers';

const RULE_ID = 'zero_usage_phone_line';

/**
 * A non-suspended phone line that recorded zero voice minutes, zero SMS, and
 * zero data this billing cycle. Distinct from:
 *  - `suspended_line_billed` — that one fires when the carrier marks the line
 *    suspended but is still billing it. This rule catches the ACTIVE-but-
 *    unused case (ex-employee line that was never deactivated, seasonal
 *    backup line, hospital/conference SIM left dormant).
 *  - `unused_mifi_or_jetpack_line` — hotspot devices only. Phones are
 *    excluded there and excluded here too (a hotspot can sit at zero data
 *    and still have nominal voice/SMS = null which trips this rule).
 *  - `underutilized_phone_on_premium_plan` — that requires a premium-tier
 *    plan name AND some nonzero usage signal. A line with literally zero
 *    activity should fire regardless of plan tier.
 *
 * Confidence is high (carrier reports zero across three independent signals)
 * but capped below 'high' severity because we cannot rule out:
 *  - mid-cycle activation (the bill does not expose per-line activation date)
 *  - a line activated as a spare / loaner that was legitimately untouched
 * Both are uncommon — most zero-activity lines are dead weight — but they
 * keep the severity at 'medium' and recommend a 2-cycle confirmation.
 */
export const zeroUsagePhoneLineRule: Rule = {
  id: RULE_ID,
  title: 'Active phone line with zero usage this cycle',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (line.is_suspended) return;
        if (isHotspotDevice(line.device)) return;
        // Require all three usage signals to be PRESENT and zero. A null in
        // any field means the carrier didn't report that dimension for this
        // line, which we cannot interpret as zero. This is the same null-vs-
        // zero discipline used in `unused_mifi_or_jetpack_line` (M3).
        if (
          line.data_used_gb === null ||
          line.voice_used_min === null ||
          line.sms_used_count === null
        ) {
          return;
        }
        if (line.data_used_gb > 0) return;
        if (line.voice_used_min > 0) return;
        if (line.sms_used_count > 0) return;

        const planBase = line.plan_base_cents ?? 0;
        if (planBase <= 0) return;

        findings.push({
          rule_id: RULE_ID,
          severity: 'medium',
          title: `Line shows zero usage but still billed ${formatCents(planBase)}/mo`,
          description: `This active phone line recorded 0 voice minutes, 0 SMS, and 0 GB of data this billing period while still being charged ${formatCents(planBase)}/mo for plan access. The most common cause is a line that was never deactivated when an employee left or a device was retired.`,
          recommended_action:
            'Confirm the device is in service. If the line is not in use, cancel it (eliminates the plan charge and any associated features/installments) or move it to the carrier’s vacation/suspension tier. If you cannot identify the user, ask your carrier rep for the device IMEI/activation date.',
          estimated_monthly_savings_cents: planBase,
          // Three independent zero signals + active status is a strong
          // pattern, but the mid-cycle-activation caveat keeps this below
          // suspended_line_billed's 0.97.
          confidence: 0.85,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
            plan_base_cents: planBase,
            data_used_gb: 0,
            voice_used_min: 0,
            sms_used_count: 0,
            mdn_last4: line.mdn_last4,
          },
        });
      });
    });

    return findings;
  },
};
