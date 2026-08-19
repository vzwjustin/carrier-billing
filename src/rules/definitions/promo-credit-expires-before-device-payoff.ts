import type { Rule, Finding } from '../types';
import { formatCents, monthsUntil } from '../helpers';

const RULE_ID = 'promo_credit_expires_before_device_payoff';

// A device promo credit ("$1,000 off, spread over 36 months") offsets the
// device installment so the line effectively pays ~$0 for the phone. When the
// credit's printed expiry lands BEFORE the installment plan finishes, the
// monthly device charge keeps billing with nothing offsetting it — the bill
// silently jumps by the credit amount for the remaining installments. This is
// the classic "free phone" gotcha and customers rarely catch it until it hits.
//
// The credit is still active *today* (so `expired_promo_credit` /
// `account_level_promo_about_to_expire` haven't fired) — this rule is purely
// forward-looking and structural. Estimated savings is therefore 0: it's a
// "plan for this / renegotiate before it lapses" heads-up, not waste that is
// recoverable on the current cycle.

// The credit must expire at least this many months before the device payoff
// for the gap to be worth surfacing. A 0–1 month gap is rounding/transition
// noise (the credit and the final installment often land in adjacent cycles).
const MIN_GAP_MONTHS = 2;

/**
 * Per-line forward-looking check: does an active device promotional credit
 * expire meaningfully before the device-payment plan it offsets is paid off?
 *
 * Only promo credits with an explicit future `expires_on` are evaluated —
 * loyalty/permanent discounts without a printed expiry can't be reasoned
 * about. Only DPPs with a printed `remaining_payments` count toward the
 * payoff horizon for the same reason.
 *
 * Severity `low`, confidence 0.6 ("Likely" bucket). The credit→installment
 * pairing is inferred at the line level rather than matched row-to-row, so
 * the signal is meaningful but not certain. Savings 0 (future cost increase).
 */
export const promoCreditExpiresBeforeDevicePayoffRule: Rule = {
  id: RULE_ID,
  title: 'Promotional credit expires before the device is paid off',
  appliesTo: 'all',
  evaluate: ({ bill, today }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        // Longest remaining device obligation on the line. DPPs whose
        // remaining term isn't printed (null) can't be compared, so skip them.
        let dppMonthsLeft = -Infinity;
        for (const d of line.dpp_installments) {
          if (d.remaining_payments !== null && d.remaining_payments > 0) {
            if (d.remaining_payments > dppMonthsLeft) {
              dppMonthsLeft = d.remaining_payments;
            }
          }
        }
        if (dppMonthsLeft === -Infinity) return;

        // Promo credits with an explicit future expiry that lapses well
        // before the device is paid off. Unit care: `remaining_payments` is a
        // count of remaining billing cycles, while `monthsUntil` is the number
        // of *calendar months* between today and the expiry date. A credit
        // expiring 2026-08-31 with today 2026-05-08 reads as 3 calendar months
        // but still offsets 4 cycles (May, Jun, Jul, Aug) — so the cycles the
        // credit still covers is `monthsUntil(...) + 1`. Compare like-for-like
        // (cycles vs cycles) to avoid a one-month overestimate of the gap.
        const creditCyclesLeft = (expiresOn: string): number => monthsUntil(expiresOn, today) + 1;

        const expiringCredits = line.credits.filter((c) => {
          if (!c.is_promo || c.expires_on === null || c.monthly_cents >= 0) {
            return false;
          }
          // Already expired or expiring this cycle is the other rules' job
          // (expired_promo_credit / account_level_promo_about_to_expire).
          if (monthsUntil(c.expires_on, today) <= 0) return false;
          return dppMonthsLeft - creditCyclesLeft(c.expires_on) >= MIN_GAP_MONTHS;
        });
        if (expiringCredits.length === 0) return;

        const futureIncreaseCents = expiringCredits.reduce(
          (sum, c) => sum + Math.abs(c.monthly_cents),
          0,
        );
        // The soonest-expiring qualifying credit drives the headline horizon.
        const soonestCyclesLeft = expiringCredits.reduce(
          (min, c) => Math.min(min, creditCyclesLeft(c.expires_on as string)),
          Infinity,
        );
        const soonestExpiryMonths = soonestCyclesLeft - 1;
        const gapMonths = dppMonthsLeft - soonestCyclesLeft;

        findings.push({
          rule_id: RULE_ID,
          severity: 'low',
          title: `Promotional credit lapses ~${gapMonths} month(s) before the device is paid off — bill rises ${formatCents(futureIncreaseCents)}/mo`,
          description: `This line carries a promotional credit set to expire in about ${soonestExpiryMonths} month(s), but the device payment plan still has ${dppMonthsLeft} payment(s) remaining — a gap of roughly ${gapMonths} month(s). Once the credit drops off, the device installment keeps billing with nothing offsetting it, so the line's monthly cost will rise by about ${formatCents(futureIncreaseCents)} for the rest of the installment term. This is the common "free/discounted phone" promo structure where the credit term is shorter than the financing term.`,
          recommended_action:
            'Before the credit lapses, confirm with the carrier whether the device will be paid off by then or whether the promo can be extended/renegotiated. If neither, budget for the higher line cost or consider paying off the remaining device balance to avoid carrying the full installment unoffset.',
          // Forward-looking cost increase, not waste recoverable this cycle.
          estimated_monthly_savings_cents: 0,
          // "Likely" bucket lower end: the credit→installment pairing is
          // inferred at the line level, not matched row-to-row.
          confidence: 0.6,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            dpp_months_remaining: dppMonthsLeft,
            credit_expires_in_months: soonestExpiryMonths,
            credit_cycles_remaining: soonestCyclesLeft,
            gap_months: gapMonths,
            future_monthly_increase_cents: futureIncreaseCents,
            min_gap_months: MIN_GAP_MONTHS,
            credit_names: expiringCredits.map((c) => c.name),
          },
        });
      });
    });

    return findings;
  },
};
