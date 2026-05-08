import type { Rule, Finding } from '../types';
import { formatCents, isHotspotDevice } from '../helpers';

const RULE_ID = 'unused_mifi_or_jetpack_line';
const DATA_THRESHOLD_GB = 0.1;

export const unusedMifiLineRule: Rule = {
  id: RULE_ID,
  title: 'Hotspot/MiFi/Jetpack line with effectively zero usage',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (!isHotspotDevice(line.device)) return;
        const used = line.data_used_gb ?? 0;
        if (used >= DATA_THRESHOLD_GB) return;

        const planBase = line.plan_base_cents ?? 0;

        findings.push({
          rule_id: RULE_ID,
          severity: 'medium',
          title: `Hotspot device "${line.device}" used effectively no data`,
          description: `This hotspot/MiFi/Jetpack line used ${used.toFixed(2)} GB this period (threshold ${DATA_THRESHOLD_GB} GB) while billing ${formatCents(planBase)}/mo for service. The device may be sitting in a drawer.`,
          recommended_action:
            'Confirm the device is needed. If not, suspend or cancel the line. If it is needed only for backup, consider moving it to a lower-tier plan.',
          estimated_monthly_savings_cents: planBase,
          confidence: 0.8,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            device: line.device,
            data_used_gb: used,
            plan_base_cents: planBase,
            threshold_gb: DATA_THRESHOLD_GB,
          },
        });
      });
    });

    return findings;
  },
};
