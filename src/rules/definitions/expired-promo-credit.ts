import type { Rule, Finding, Severity } from '../types';
import type { ExtractedCredit } from '@/extraction/schema';
import { expiresWithinDays, formatCents, isExpired } from '../helpers';

const RULE_ID = 'expired_promo_credit';

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
    ? `${where} "${credit.name}" has expired (${formatCents(amount)}/mo lost)`
    : `${where} "${credit.name}" expires within 30 days`;
  const description = isExpiredNow
    ? `The ${formatCents(amount)}/mo ${scope}-level credit "${credit.name}" expired on ${credit.expires_on}. The discount is no longer being applied to this bill, so the line/account is paying full price until a renewal credit is negotiated.`
    : `The ${formatCents(amount)}/mo ${scope}-level credit "${credit.name}" expires on ${credit.expires_on}. Once it falls off, the bill will increase by ${formatCents(amount)}/mo unless a renewal is in place.`;
  const recommended_action = isExpiredNow
    ? 'Contact your carrier representative to negotiate a renewal or replacement promotional credit. Reference the credit name and expiration date when escalating, and ask for back-credit covering any periods billed after expiration.'
    : 'Contact your carrier representative now to renew this credit before it lapses. Most carriers prefer to renew before expiration rather than restore after.';
  // Already-expired credits are unambiguous (we have the date), so confidence
  // is higher than for "expiring soon" findings which are forward-looking.
  const confidence = isExpiredNow ? 0.98 : 0.95;
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
