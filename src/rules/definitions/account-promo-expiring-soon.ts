import type { Rule, Finding } from '../types';
import { daysUntil, formatCents, isExpired } from '../helpers';

const RULE_ID = 'account_level_promo_about_to_expire';

// Window: 31..60 days. Credits expiring within 0..30 days are handled by
// expired_promo_credit's "expiring within 30 days" branch — firing both
// rules on the same credit produced duplicate findings. This rule complements
// the other by covering the 31..60 day "renewal window" that the 30-day
// branch misses; already-expired credits also stay with expired_promo_credit.
const WINDOW_MIN_DAYS = 31;
const WINDOW_MAX_DAYS = 60;

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
        if (days < WINDOW_MIN_DAYS || days > WINDOW_MAX_DAYS) return;

        const amount = Math.abs(credit.monthly_cents);

        const dayWord = days === 1 ? 'day' : 'days';
        findings.push({
          rule_id: RULE_ID,
          severity: 'medium',
          title: `Account credit "${credit.name}" expires in ${days} ${dayWord}`,
          description: `Account-level promotional credit "${credit.name}" of ${formatCents(amount)}/mo expires on ${credit.expires_on} — exactly ${days} ${dayWord} from today. Without renewal, the account bill will increase by ${formatCents(amount)}/mo on that date.`,
          recommended_action:
            'Open a renewal conversation with your carrier representative now so a replacement credit is in place before this one lapses.',
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
