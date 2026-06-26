import type { Rule, Finding } from '../types';
import type { ContractWithTerms } from '@/contracts/schema';
import { formatCents } from '../helpers';

const RULE_ID = 'contract_rate_mismatch';

// Bill must be at least 10% above contract rate before we fire. Anything
// smaller is rounding noise from tier-based discounts that apply mid-cycle
// or proration on partial-month activations.
const OVERAGE_THRESHOLD_RATIO = 0.1;

/**
 * Loose plan-name comparison. Carriers print plan names with leading/
 * trailing whitespace, occasional registered-trademark glyphs, and
 * inconsistent casing between the contract and the bill ("Business
 * Unlimited Pro 2.0" vs. "BUSINESS UNLIMITED PRO 2.0"). We normalize both
 * sides before comparing rather than requiring rules authors to match the
 * exact carrier-rendered string.
 */
function normalizePlanName(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Carrier scoping for contracts. The bill is unambiguous about its carrier;
 * the contract may carry `null` or `'unknown'` (extractor couldn't tell).
 * We require an explicit match against the bill's carrier or accept the
 * contract when its carrier is null/unknown (treat as "applies to this
 * carrier by default") rather than dropping potentially-relevant
 * contracts. False positives are bounded by the plan-name match which is
 * strict on both sides.
 */
function contractCarrierMatches(contract: ContractWithTerms, billCarrier: string): boolean {
  if (contract.carrier === null) return true;
  if (contract.carrier === 'unknown') return true;
  return contract.carrier === billCarrier;
}

export const contractRateMismatchRule: Rule = {
  id: RULE_ID,
  title: 'Line billed above the contracted rate',
  appliesTo: 'all',
  evaluate: ({ bill, carrier, contracts }) => {
    const findings: Finding[] = [];

    if (!contracts || contracts.length === 0) return findings;

    // Pre-build a lookup of normalized contract plan_name → matching
    // contract+rate so the inner loop is O(1) per line.
    type ContractEntry = {
      contract: ContractWithTerms;
      planName: string;
      contractedRate: number;
    };
    const eligible: ContractEntry[] = [];
    for (const c of contracts) {
      if (!contractCarrierMatches(c, carrier)) continue;
      const terms = c.terms;
      if (!terms) continue;
      const rate = terms.contracted_monthly_rate_cents;
      if (rate === null || rate <= 0) continue;
      const planName = normalizePlanName(terms.plan_name);
      if (planName === '') continue;
      eligible.push({ contract: c, planName, contractedRate: rate });
    }

    if (eligible.length === 0) return findings;

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        const lineRate = line.plan_base_cents;
        if (lineRate === null) return;
        const planNorm = normalizePlanName(line.plan_name);
        if (planNorm === '') return;

        const match = eligible.find((e) => e.planName === planNorm);
        if (!match) return;

        const overage = lineRate - match.contractedRate;
        if (overage <= 0) return;
        const ratio = overage / match.contractedRate;
        if (ratio < OVERAGE_THRESHOLD_RATIO) return;

        const percentOver = Math.round(ratio * 100);
        findings.push({
          rule_id: RULE_ID,
          severity: 'high',
          title: `Line plan "${line.plan_name}" billed ${percentOver}% above contracted rate`,
          description: `Your contract specifies ${formatCents(match.contractedRate)}/mo for "${match.contract.terms?.plan_name ?? line.plan_name}", but this line is being billed ${formatCents(lineRate)}/mo — a ${formatCents(overage)}/mo overage (${percentOver}%).`,
          recommended_action: `Dispute this line with your carrier representative. Reference the contracted rate of ${formatCents(match.contractedRate)}/mo and request (a) the contracted rate going forward and (b) back-credit for any months billed at the higher rate. Cite the contract effective date if available.`,
          estimated_monthly_savings_cents: overage,
          confidence: 0.9,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            contract_id: match.contract.id,
            contract_plan_name: match.contract.terms?.plan_name ?? null,
            contract_carrier: match.contract.carrier,
            contracted_monthly_rate_cents: match.contractedRate,
            billed_plan_name: line.plan_name,
            billed_plan_base_cents: lineRate,
            overage_cents: overage,
            overage_ratio_bps: Math.round(ratio * 10_000),
          },
        });
      });
    });

    return findings;
  },
};
