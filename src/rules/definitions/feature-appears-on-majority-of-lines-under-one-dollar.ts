import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'feature_appears_on_majority_of_lines_under_one_dollar';

// "Under $1" — features priced sub-100¢ that fan out across a fleet are
// almost always one of:
//   - a $0/$0.01 documentation row the carrier prints to expose a
//     plan-included entitlement (these add up to pennies, but they multiply
//     across hundreds of lines and become real money on enterprise accounts)
//   - a "regulatory recovery $0.01" fee the carrier rolled out fleet-wide
//     and that some accounts have negotiated away
const UNDER_DOLLAR_CENTS = 100;
// Fraction-of-lines threshold for "majority". 0.8 catches a fleet-wide SOC
// without firing on a 50/50 split (which usually has a real business reason).
const FAN_OUT_FRACTION = 0.8;
// Statistical floor — at < 3 lines the "80%" math is meaningless. The
// snapshot fixture has 2 lines and intentionally does not satisfy this gate.
const MIN_LINES = 3;

/**
 * A feature name that appears on ≥80% of the lines on an account, every
 * occurrence under $1/mo. Likely a fleet-wide documentation row or a
 * pennies-each surcharge — individually trivial, collectively worth asking
 * the carrier rep about (especially at 100+ line scale).
 *
 * Severity `info`, confidence 0.5 (Speculative bucket per types.ts). The
 * recurring saving is real but small per line; the value of the finding
 * is the question it prompts, not the dollar figure.
 */
export const featureAppearsOnMajorityOfLinesUnderOneDollarRule: Rule = {
  id: RULE_ID,
  title: 'Sub-$1 feature appearing fleet-wide on an account',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      if (account.lines.length < MIN_LINES) return;

      // Group features by name. Track each occurrence's line index +
      // monthly_cents so we can both compute the fan-out fraction and emit
      // affected_line_indexes accurately.
      const byName = new Map<
        string,
        Array<{ lineIndex: number; monthly_cents: number; original_name: string }>
      >();
      account.lines.forEach((line, lineIndex) => {
        for (const f of line.features) {
          const key = f.name.trim().toLowerCase();
          if (key.length === 0) continue;
          const bucket = byName.get(key) ?? [];
          bucket.push({
            lineIndex,
            monthly_cents: f.monthly_cents,
            original_name: f.name,
          });
          byName.set(key, bucket);
        }
      });

      const lineCount = account.lines.length;
      const threshold = Math.ceil(lineCount * FAN_OUT_FRACTION);

      for (const [, occurrences] of byName) {
        if (occurrences.length < threshold) continue;
        // Every occurrence must be under $1. A single $5 occurrence breaks
        // the "trivial-per-line" framing this rule depends on.
        if (occurrences.some((o) => o.monthly_cents >= UNDER_DOLLAR_CENTS)) {
          continue;
        }

        const total = occurrences.reduce((sum, o) => sum + o.monthly_cents, 0);
        // Per-line >0 cents: a fleet-wide $0 row IS informational but the
        // operator action ("ask the rep to remove it") only matters when
        // something is actually being charged. Skip the all-zero case.
        if (total <= 0) continue;

        const firstOccurrence = occurrences[0];
        if (firstOccurrence === undefined) continue;
        const displayName = firstOccurrence.original_name;
        const lineIndexes = occurrences.map((o) => o.lineIndex);
        const fraction = occurrences.length / lineCount;

        findings.push({
          rule_id: RULE_ID,
          severity: 'info',
          title: `"${displayName}" charged on ${occurrences.length} of ${lineCount} lines at under $1 each`,
          description: `Feature "${displayName}" appears on ${occurrences.length} of ${lineCount} lines on this account (${(fraction * 100).toFixed(0)}%), each charged at under $1/mo for a total of ${formatCents(total)}/mo. Fleet-wide pennies-each SOCs are typically either a $0.01 documentation row or a recovery-fee bucket that some accounts have negotiated away; at enough scale it's worth a question to the rep.`,
          recommended_action:
            "Ask your carrier rep to identify the SOC behind this feature row. If it's purely a documentation/entitlement-display row, request that it be removed for tidiness; if it's a recovery surcharge, ask whether the account is eligible for a waiver.",
          estimated_monthly_savings_cents: total,
          // Speculative bucket (0.5) per types.ts. The signal is structural
          // but the underlying cause varies — sometimes the SOC is required
          // by the carrier's billing system and can't be removed.
          confidence: 0.5,
          affected_line_indexes: lineIndexes,
          affected_account_indexes: [accountIndex],
          evidence: {
            feature_name: displayName,
            occurrences: occurrences.length,
            line_count: lineCount,
            fraction: Number(fraction.toFixed(2)),
            total_monthly_cents: total,
            // Bolt Optimization: Replace spread operator Math.max() with reduce
            // to avoid array allocations and prevent Call Stack limit exceptions on edge runtime
            per_line_max_cents: occurrences.reduce((max, o) => Math.max(max, o.monthly_cents), -Infinity),
          },
        });
      }
    });

    return findings;
  },
};
