import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'account_taxes_fees_low_anomaly';

// US business wireless surcharges + taxes typically sit in the 12-25% band
// of the pre-tax account total. A ratio below 4% is well outside any
// legitimate band and almost always indicates a parser miss (the LLM
// didn't pick up the "Other charges & credits" or surcharge section) or a
// partial / partial-cycle bill. This is a parser-quality smell, not waste.
const LOW_RATIO_THRESHOLD = 0.04;
// Skip rows under $10 in total — too small to draw any signal from.
const MIN_TOTAL_CENTS = 1000;

/**
 * Account where the extracted `taxes_fees_cents` is suspiciously low
 * relative to total charges. Paired counterpart to
 * `disproportionate_taxes_fees` (which flags HIGH ratios). This one is
 * intentionally classified `info` severity / `0.5` confidence: it's a
 * "trust the data less" hint for the operator, not a savings finding.
 *
 * Skip behavior: when `taxes_fees_cents` is null the extractor explicitly
 * said "didn't find" — which is its own kind of signal but is out of scope
 * for this rule (the missing-section case is handled at the extraction
 * pipeline level via the overall bill `confidence` downgrade).
 */
export const accountTaxesFeesLowAnomalyRule: Rule = {
  id: RULE_ID,
  title: 'Account taxes and fees suspiciously low (possible parser miss)',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      // Skip when extractor returned null — that's the absent-section case,
      // not the suspicious-low case.
      if (account.taxes_fees_cents === null) return;
      const fees = account.taxes_fees_cents;
      const total = account.total_charges_cents;
      if (total < MIN_TOTAL_CENTS) return;

      const ratio = fees / total;
      if (ratio >= LOW_RATIO_THRESHOLD) return;

      findings.push({
        rule_id: RULE_ID,
        severity: 'info',
        title: `Account taxes & fees only ${(ratio * 100).toFixed(1)}% of charges`,
        description: `This account shows ${formatCents(fees)} in taxes and fees against ${formatCents(total)} in total charges (${(ratio * 100).toFixed(1)}% ratio). US business wireless surcharges plus taxes typically run 12-25%; a ratio under 4% usually indicates a missing line item, a partial-cycle / prorated bill, or a parser miss on the "Other charges and credits" section. Treat the savings figures on this account with extra caution until the full surcharge section is confirmed.`,
        recommended_action:
          'Compare this bill\'s "Surcharges" / "Government taxes & fees" totals against the printed PDF. If the printed totals are higher than what shows here, re-upload the bill or attach the missing pages — the audit may understate savings until the fee section is parsed.',
        // Parser-quality smell, not waste. Never roll into savings.
        estimated_monthly_savings_cents: 0,
        // "Likely" bucket per types.ts — half-confident this isn't just a
        // genuinely low-tax jurisdiction (some states + EZ-pass-style fee
        // structures do come in below 10%, though 4% is still a stretch).
        confidence: 0.5,
        affected_line_indexes: [],
        affected_account_indexes: [accountIndex],
        evidence: {
          taxes_fees_cents: fees,
          total_charges_cents: total,
          ratio: Number(ratio.toFixed(3)),
          threshold: LOW_RATIO_THRESHOLD,
        },
      });
    });

    return findings;
  },
};
