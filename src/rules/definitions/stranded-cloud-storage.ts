import type { Rule, Finding } from '../types';
import { findFeatureByCategory, formatCents } from '../helpers';

const RULE_ID = 'stranded_cloud_storage';

// Symmetric to `orphan_insurance` but for cloud-category features. Verizon
// Cloud, AT&T Photo Storage, and similar add-ons billed on a line with no
// active device are dead weight — there's nothing on the device side to
// back up.
export const strandedCloudStorageRule: Rule = {
  id: RULE_ID,
  title: 'Cloud storage feature on a line with no active device',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const cloud = findFeatureByCategory(line, 'cloud');
        if (cloud.length === 0) return;

        // Mirror orphan-insurance triggers — but cloud is more leniently
        // useful (BYOD users may legitimately back up to carrier cloud), so
        // we only fire on the two strongest signals: suspended OR truly
        // empty (no device + no DPP).
        const isSuspended = line.is_suspended;
        const noDeviceNoDpp =
          line.device === null && line.dpp_installments.length === 0;
        if (!isSuspended && !noDeviceNoDpp) return;

        const total = cloud.reduce((sum, f) => sum + f.monthly_cents, 0);
        const names = cloud.map((f) => f.name).join(', ');
        findings.push({
          rule_id: RULE_ID,
          severity: isSuspended ? 'medium' : 'low',
          title: `Cloud storage billed on a line with no active device`,
          description: `This line is ${isSuspended ? 'suspended' : 'missing a device and has no active device payment'} but is being billed ${formatCents(total)}/mo for cloud features (${names}). There is no device generating data for the cloud feature to back up.`,
          recommended_action:
            'Remove the cloud feature from this line. If the underlying data needs to remain accessible, export it to a personal cloud first.',
          estimated_monthly_savings_cents: total,
          confidence: 0.75,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            cloud_features: cloud.map((f) => ({
              name: f.name,
              monthly_cents: f.monthly_cents,
            })),
            is_suspended: isSuspended,
            no_device_no_dpp: noDeviceNoDpp,
          },
        });
      });
    });

    return findings;
  },
};
