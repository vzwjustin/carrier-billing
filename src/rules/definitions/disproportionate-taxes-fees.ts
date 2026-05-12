import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'disproportionate_taxes_fees';

// A surcharge-and-tax burden above this fraction of the pre-tax/fee portion
// of the account is unusually high for US business wireless and warrants a
// look. Typical business wireless fees+taxes run 15–22% — 25%+ is a strong
// signal of a mis-mapped regulatory-recovery bucket or an erroneous
// "administrative fee" that the carrier rep can usually remove.
const HIGH_RATIO_THRESHOLD = 0.25;
const MIN_FEES_CENTS = 1000; // skip rows under $10 in fees (noise floor)

export const disproportionateTaxesFeesRule: Rule = {
  id: RULE_ID,
  title: 'Taxes and fees disproportionate to account charges',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      const fees = account.taxes_fees_cents ?? 0;
      if (fees < MIN_FEES_CENTS) return;
      const total = account.total_charges_cents;
      if (total <= 0) return;
      const preTax = total - fees;
      if (preTax <= 0) return;
      const ratio = fees / preTax;
      if (ratio < HIGH_RATIO_THRESHOLD) return;

      // The actionable saving is the *excess* over the typical 22% band, not
      // the full fee. Conservative: estimate savings as the portion of fees
      // above the threshold (a rep can usually credit back the
      // miscategorized fees, not the legitimate taxes).
      const expectedAt22 = preTax * 0.22;
      const excess = Math.max(0, fees - expectedAt22);

      findings.push({
        rule_id: RULE_ID,
        severity: 'low',
        title: `Account taxes & fees are ${(ratio * 100).toFixed(0)}% of charges`,
        description: `This account has ${formatCents(fees)} in taxes and fees against ${formatCents(preTax)} in pre-tax charges (${(ratio * 100).toFixed(0)}% ratio). US business wireless typically runs 15–22%; a ratio above 25% is often a mis-categorized "regulatory recovery" or "administrative" surcharge bucket the carrier can credit back.`,
        recommended_action:
          'Open a fee-detail review with your carrier representative. Ask for an itemized breakdown of "Other charges and credits" — surcharges in this bucket that aren\'t actual government-imposed taxes are routinely negotiable.',
        estimated_monthly_savings_cents: excess,
        confidence: 0.5,
        affected_line_indexes: [],
        affected_account_indexes: [accountIndex],
        evidence: {
          taxes_fees_cents: fees,
          pre_tax_cents: preTax,
          total_charges_cents: total,
          ratio: Number(ratio.toFixed(3)),
          threshold: HIGH_RATIO_THRESHOLD,
        },
      });
    });

    return findings;
  },
};
