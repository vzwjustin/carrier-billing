import type { Rule, Finding, Severity } from '../types';
import type { ExtractedCredit } from '@/extraction/schema';
import { expiresWithinDays, formatCents, isExpired } from '../helpers';

const RULE_ID = 'expired_promo_credit';

// Name patterns that strongly suggest a promotional credit (vs. a one-shot
// adjustment / loyalty bonus). Used both as a soft guard against the LLM
// flagging is_promo=false on something that's clearly a promo, and to tune
// the confidence score (L1).
const PROMO_NAME_RE = /\b(promo|promotional|discount|loyalty|bonus|incentive)\b/i;

function buildFinding(args: {
  credit: ExtractedCredit;
  isExpiredNow: boolean;
  accountIndex: number;
  lineIndex: number | null;
  scope: 'account' | 'line';
}): Finding {
  const { credit, isExpiredNow, accountIndex, lineIndex, scope } = args;
  const severity: Severity = isExpiredNow ? 'high' : 'medium';
  const amount = Math.abs(credit.monthly_cents);
  const where = scope === 'account' ? 'Account credit' : 'Line credit';
  const title = isExpiredNow
    ? `${where} "${credit.name}" has expired (${formatCents(amount)}/mo at risk)`
    : `${where} "${credit.name}" expires within 30 days`;
  // H1: the prior wording claimed the discount was "no longer being applied
  // to this bill". That overstates what we know — a credit row appearing on
  // the extracted bill MAY be its final-cycle application (the expiry can
  // sit anywhere within the billing period). State only the next-cycle
  // consequence, which we can defend regardless of whether the credit shows
  // on the current cycle.
  const description = isExpiredNow
    ? `The ${formatCents(amount)}/mo ${scope}-level credit "${credit.name}" expired on ${credit.expires_on}. The next bill will be ${formatCents(amount)}/mo higher unless a renewal credit is in place. If the credit still appears on this current bill it is the last cycle that will carry it.`
    : `The ${formatCents(amount)}/mo ${scope}-level credit "${credit.name}" expires on ${credit.expires_on}. Once it falls off, the bill will increase by ${formatCents(amount)}/mo unless a renewal is in place.`;
  const recommended_action = isExpiredNow
    ? 'Contact your carrier representative to negotiate a renewal or replacement promotional credit. Reference the credit name and expiration date when escalating, and ask for back-credit covering any periods billed after expiration.'
    : 'Contact your carrier representative now to renew this credit before it lapses. Most carriers prefer to renew before expiration rather than restore after.';
  // L1: confidence reflects what we actually know about the credit. A
  // promo-shaped name on an `is_promo: true` row is the strongest signal;
  // a non-matching name on a promo flag is softer.
  const nameLooksPromo = PROMO_NAME_RE.test(credit.name);
  const baseConfidence = isExpiredNow ? 0.95 : 0.9;
  const confidence = nameLooksPromo ? baseConfidence : baseConfidence - 0.1;
  return {
    rule_id: RULE_ID,
    severity,
    title,
    description,
    recommended_action,
    estimated_monthly_savings_cents: amount,
    confidence,
    affected_line_indexes: lineIndex === null ? [] : [lineIndex],
    affected_account_indexes: [accountIndex],
    evidence: {
      credit_name: credit.name,
      expires_on: credit.expires_on,
      monthly_cents: credit.monthly_cents,
      scope,
      is_promo: credit.is_promo,
      name_matched_promo_pattern: nameLooksPromo,
    },
  };
}

export const expiredPromoCreditRule: Rule = {
  id: RULE_ID,
  title: 'Expired or expiring promotional credit',
  appliesTo: 'all',
  evaluate: ({ bill, today }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.account_level_credits.forEach((credit) => {
        if (credit.expires_on === null) return;
        // H2: this rule is explicitly about promotional credits. One-shot
        // ops adjustments and loyalty bonuses (is_promo=false per the LLM
        // prompt) are not in scope — they were producing false-positive
        // findings with overconfident savings claims.
        if (!credit.is_promo) return;
        const expired = isExpired(credit.expires_on, today);
        const expiringSoon = expiresWithinDays(credit.expires_on, today, 30);
        if (!expired && !expiringSoon) return;
        findings.push(
          buildFinding({
            credit,
            isExpiredNow: expired,
            accountIndex,
            lineIndex: null,
            scope: 'account',
          }),
        );
      });

      account.lines.forEach((line, lineIndex) => {
        line.credits.forEach((credit) => {
          if (credit.expires_on === null) return;
          if (!credit.is_promo) return;
          const expired = isExpired(credit.expires_on, today);
          const expiringSoon = expiresWithinDays(credit.expires_on, today, 30);
          if (!expired && !expiringSoon) return;
          findings.push(
            buildFinding({
              credit,
              isExpiredNow: expired,
              accountIndex,
              lineIndex,
              scope: 'line',
            }),
          );
        });
      });
    });

    return findings;
  },
};
