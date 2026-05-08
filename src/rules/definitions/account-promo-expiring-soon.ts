import type { Rule, Finding, Severity } from '../types';
import { daysUntil, formatCents, isExpired } from '../helpers';

const RULE_ID = 'account_level_promo_about_to_expire';

export const accountPromoExpiringSoonRule: Rule = {
  id: RULE_ID,
  title: 'Account-level promotional credit expiring soon',
  appliesTo: 'all',
  evaluate: ({ bill, today }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.account_level_credits.forEach((credit) => {
        if (credit.expires_on === null) return;
        // Already-expired account credits are covered by expired_promo_credit.
        if (isExpired(credit.expires_on, today)) return;

        const days = daysUntil(credit.expires_on, today);
        // Window: 0..60 days. The 0..30 window overlaps with
        // expired_promo_credit's "expiring within 30 days" branch on purpose:
        // this rule adds the "very soon" (<14 days) high-severity escalation
        // and the 31-60 day mid-range warning that the other rule misses.
        if (days < 0 || days > 60) return;

        const severity: Severity = days <= 14 ? 'high' : 'medium';
        const amount = Math.abs(credit.monthly_cents);

        const dayWord = days === 1 ? 'day' : 'days';
        findings.push({
          rule_id: RULE_ID,
          severity,
          title: `Account credit "${credit.name}" expires in ${days} ${dayWord}`,
          description: `Account-level promotional credit "${credit.name}" of ${formatCents(amount)}/mo expires on ${credit.expires_on} — exactly ${days} ${dayWord} from today. Without renewal, the account bill will increase by ${formatCents(amount)}/mo on that date.`,
          recommended_action:
            days <= 14
              ? 'Escalate this week to your carrier representative. Reference the credit name and demand a renewal or replacement before it falls off the bill.'
              : 'Open a renewal conversation with your carrier representative now so a replacement credit is in place before this one lapses.',
          estimated_monthly_savings_cents: amount,
          confidence: 0.9,
          affected_line_indexes: [],
          affected_account_indexes: [accountIndex],
          evidence: {
            credit_name: credit.name,
            expires_on: credit.expires_on,
            days_until_expiry: days,
            monthly_cents: credit.monthly_cents,
          },
        });
      });
    });

    return findings;
  },
};
