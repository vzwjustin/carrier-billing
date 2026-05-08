import type { Rule, Finding, Severity } from '../types';
import { findFeatureByCategory, formatCents } from '../helpers';

const RULE_ID = 'orphan_insurance';

export const orphanInsuranceRule: Rule = {
  id: RULE_ID,
  title: 'Insurance/protection feature on a line with no active device',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const insuranceFeatures = findFeatureByCategory(line, 'insurance');
        if (insuranceFeatures.length === 0) return;

        // TODO(domain): refine "no active device" definition. Today we treat
        // a line as orphaned if it's suspended, OR has no device on file AND
        // no DPP installments. Justin may want to fold in BYOD signals or
        // device-trade-in markers per carrier.
        const isSuspended = line.is_suspended;
        const noDevice = line.device === null && line.dpp_installments.length === 0;
        if (!isSuspended && !noDevice) return;

        const totalCents = insuranceFeatures.reduce(
          (sum, f) => sum + f.monthly_cents,
          0,
        );
        const severity: Severity = isSuspended ? 'high' : 'medium';
        const reason = isSuspended
          ? 'this line is suspended'
          : 'this line has no device on file and no active device payment plan';

        findings.push({
          rule_id: RULE_ID,
          severity,
          title: `Insurance billed on a line with no active device`,
          description: `${insuranceFeatures.length} protection feature(s) totaling ${formatCents(totalCents)}/mo are being charged, but ${reason}. There is no device for the policy to cover.`,
          recommended_action:
            'Remove the protection feature(s) from this line. If the device returns to service, protection can be re-added at that time.',
          estimated_monthly_savings_cents: totalCents,
          confidence: 0.85,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            insurance_features: insuranceFeatures.map((f) => ({
              name: f.name,
              monthly_cents: f.monthly_cents,
            })),
            is_suspended: isSuspended,
            has_device: line.device !== null,
            dpp_count: line.dpp_installments.length,
          },
        });
      });
    });

    return findings;
  },
};
