import type { Rule, Finding, Severity } from '../types';
import { formatCents, isHotspotDevice } from '../helpers';

const RULE_ID = 'unused_mifi_or_jetpack_line';
// Two-tier thresholds: <0.1 GB = "in a drawer", <1 GB = "barely used".
const ZERO_USE_THRESHOLD_GB = 0.1;
const LIGHT_USE_THRESHOLD_GB = 1;

export const unusedMifiLineRule: Rule = {
  id: RULE_ID,
  title: 'Hotspot/MiFi/Jetpack line with effectively zero usage',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (!isHotspotDevice(line.device)) return;
        // Missing usage data is NOT a confident-zero signal — some carriers
        // simply don't report per-line usage on every bill, and treating
        // null as 0 would flag any line on those carriers as "unused".
        if (line.data_used_gb === null) return;
        const used = line.data_used_gb;
        if (used >= LIGHT_USE_THRESHOLD_GB) return;

        const planBase = line.plan_base_cents ?? 0;
        const isZeroUse = used < ZERO_USE_THRESHOLD_GB;
        // M3: cap severity at 'low' until ExtractedLineSchema carries an
        // activation-in-period flag. A brand-new hotspot activated 3 days
        // into the billing cycle can legitimately read ~0 GB; high-severity
        // "suspend or cancel this line" findings on freshly-deployed devices
        // burn auditor credibility.
        const severity: Severity = 'low';
        const threshold = isZeroUse
          ? ZERO_USE_THRESHOLD_GB
          : LIGHT_USE_THRESHOLD_GB;

        const title = isZeroUse
          ? `Hotspot device "${line.device}" used effectively no data`
          : `Hotspot device "${line.device}" used very little data`;

        const description = isZeroUse
          ? `This hotspot/MiFi/Jetpack line used ${used.toFixed(2)} GB this period (under the ${ZERO_USE_THRESHOLD_GB} GB "drawer" threshold) while billing ${formatCents(planBase)}/mo for service. The device may be sitting unused — or it may have been activated mid-cycle (the bill does not expose activation dates per line).`
          : `This hotspot/MiFi/Jetpack line used only ${used.toFixed(2)} GB this period (under ${LIGHT_USE_THRESHOLD_GB} GB) while billing ${formatCents(planBase)}/mo. Light usage may justify a smaller plan or consolidation.`;

        const recommended_action = isZeroUse
          ? 'If the line has been active for at least one full billing cycle and usage stays this low, suspend or cancel. If recently activated, re-check next cycle.'
          : 'Confirm whether this hotspot needs its own line. Light, occasional use can often be served by a phone hotspot feature included on a primary line.';

        findings.push({
          rule_id: RULE_ID,
          severity,
          title,
          description,
          recommended_action,
          estimated_monthly_savings_cents: planBase,
          // M3: confidence drops because we cannot rule out mid-cycle
          // activation. Bump back up once `activation_date_in_period` lands.
          confidence: isZeroUse ? 0.65 : 0.7,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            device: line.device,
            data_used_gb: used,
            plan_base_cents: planBase,
            threshold_gb: threshold,
            tier: isZeroUse ? 'zero_use' : 'light_use',
          },
        });
      });
    });

    return findings;
  },
};
