import type { Rule, Finding, Severity } from '../types';
import { findFeatureByCategory, formatCents } from '../helpers';

const RULE_ID = 'orphan_insurance';

const BYOD_RE = /\b(byod|bring\s+your\s+own)\b/i;

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

        // Three orphan heuristics, ranked by strength:
        //   1. Line is suspended → device isn't in service, insurance is dead weight.
        //   2. No device on file AND no DPP installments → ghost line.
        //   3. Plan base is $0 and line isn't suspended → "feature-only" zombie line
        //      that's accumulating add-ons against nothing. (Some carriers leave
        //      lines like this when a device is returned but features aren't audited.)
        // is_byod is captured in evidence for context, but does NOT add a
        // separate trigger reason: a suspended BYOD line is already covered
        // by `line_suspended`, and pushing both produced duplicate-looking
        // reasons in the evidence array.
        const triggerReasons: string[] = [];
        const isSuspended = line.is_suspended;
        const isByod = line.device !== null && BYOD_RE.test(line.device);
        // BYOD lines with insurance are an intentional consumer choice — the
        // customer brought their own device and elected to insure it (often
        // through carrier protection on a $0-base plan). Gate the
        // "no device" and "feature-only zombie" heuristics on !isByod so the
        // rule doesn't flag a legitimate BYOD policy as waste. Suspended BYOD
        // lines still fire via `line_suspended` (the policy is dead weight on
        // a suspended line regardless of who owns the device).
        const noDevice =
          !isByod &&
          line.device === null &&
          line.dpp_installments.length === 0;
        // The early return at the top of the loop already guarantees
        // insuranceFeatures.length > 0 — drop the dead-code re-check.
        const isFeatureOnlyZombie =
          !isSuspended && !isByod && line.plan_base_cents === 0;

        if (isSuspended) triggerReasons.push('line_suspended');
        if (noDevice) triggerReasons.push('no_device_no_dpp');
        if (isFeatureOnlyZombie) triggerReasons.push('feature_only_zombie');

        if (triggerReasons.length === 0) return;

        const totalCents = insuranceFeatures.reduce(
          (sum, f) => sum + f.monthly_cents,
          0,
        );
        // Suspended lines are highest confidence; the other heuristics are
        // medium severity since BYOD/feature-only states can be intentional.
        const severity: Severity = isSuspended ? 'high' : 'medium';

        const reasonText = isSuspended
          ? 'this line is suspended'
          : isFeatureOnlyZombie
            ? 'this line has no plan charge and appears to be carrying features only'
            : 'this line has no device on file and no active device payment plan';

        findings.push({
          rule_id: RULE_ID,
          severity,
          title: `Insurance billed on a line with no active device`,
          description: `${insuranceFeatures.length} protection feature(s) totaling ${formatCents(totalCents)}/mo are being charged, but ${reasonText}. There is no device for the policy to cover.`,
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
            plan_base_cents: line.plan_base_cents,
            is_byod: isByod,
            triggerReasons,
          },
        });
      });
    });

    return findings;
  },
};
