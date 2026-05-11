import type { Rule, Finding } from '../types';
import type { ExtractedCredit } from '@/extraction/schema';
import { daysUntil, formatCents, isExpired } from '../helpers';

// Rule id retained ('account_level_…') for backward compatibility with
// historical persisted findings; the rule now also covers line-level credits
// in the same 31..60d renewal window (H3). The 'account_level_' prefix in the
// id is purely historical at this point.
const RULE_ID = 'account_level_promo_about_to_expire';

// Window: 31..60 days. Credits expiring within 0..30 days are handled by
// expired_promo_credit's "expiring within 30 days" branch — firing both
// rules on the same credit produced duplicate findings. This rule complements
// the other by covering the 31..60 day "renewal window" that the 30-day
// branch misses; already-expired credits also stay with expired_promo_credit.
const WINDOW_MIN_DAYS = 31;
const WINDOW_MAX_DAYS = 60;

function evaluateCredit(args: {
  credit: ExtractedCredit;
  today: Date;
  accountIndex: number;
  lineIndex: number | null;
  scope: 'account' | 'line';
}): Finding | null {
  const { credit, today, accountIndex, lineIndex, scope } = args;
  if (credit.expires_on === null) return null;
  // is_promo gate matches expired_promo_credit's H2 fix — this rule is also
  // about promo renewals, not one-shot adjustments.
  if (!credit.is_promo) return null;
  // Already-expired credits are covered by expired_promo_credit.
  if (isExpired(credit.expires_on, today)) return null;

  const days = daysUntil(credit.expires_on, today);
  if (days < WINDOW_MIN_DAYS || days > WINDOW_MAX_DAYS) return null;

  const amount = Math.abs(credit.monthly_cents);
  const dayWord = days === 1 ? 'day' : 'days';
  const where = scope === 'account' ? 'Account credit' : 'Line credit';
  const subject = scope === 'account' ? 'account-level' : 'line-level';
  return {
    rule_id: RULE_ID,
    severity: 'medium',
    title: `${where} "${credit.name}" expires in ${days} ${dayWord}`,
    description: `${where === 'Account credit' ? 'Account-level' : 'Line-level'} promotional credit "${credit.name}" of ${formatCents(amount)}/mo expires on ${credit.expires_on} — exactly ${days} ${dayWord} from today. Without renewal, the ${subject} charge will increase by ${formatCents(amount)}/mo on that date.`,
    recommended_action:
      'Open a renewal conversation with your carrier representative now so a replacement credit is in place before this one lapses.',
    estimated_monthly_savings_cents: amount,
    confidence: 0.9,
    affected_line_indexes: lineIndex === null ? [] : [lineIndex],
    affected_account_indexes: [accountIndex],
    evidence: {
      credit_name: credit.name,
      expires_on: credit.expires_on,
      days_until_expiry: days,
      monthly_cents: credit.monthly_cents,
      scope,
    },
  };
}

export const accountPromoExpiringSoonRule: Rule = {
  id: RULE_ID,
  title: 'Promotional credit expiring in 31–60 days',
  appliesTo: 'all',
  evaluate: ({ bill, today }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.account_level_credits.forEach((credit) => {
        const f = evaluateCredit({
          credit,
          today,
          accountIndex,
          lineIndex: null,
          scope: 'account',
        });
        if (f) findings.push(f);
      });

      // H3: line-level credits in the same 31..60d window. Per-line
      // device-payoff promos that lapse after 36 months are the most common
      // "bill jump next month" pattern; previously they fell through entirely
      // (expired_promo_credit covers ≤30d; this rule was account-only).
      account.lines.forEach((line, lineIndex) => {
        line.credits.forEach((credit) => {
          const f = evaluateCredit({
            credit,
            today,
            accountIndex,
            lineIndex,
            scope: 'line',
          });
          if (f) findings.push(f);
        });
      });
    });

    return findings;
  },
};
