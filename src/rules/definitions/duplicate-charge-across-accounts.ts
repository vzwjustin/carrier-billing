import type { Rule, Finding } from '../types';
import {
  buildDetectorInput,
  detectCrossAuditDuplicates,
  DUPLICATE_RULE_IDS,
} from '@/duplicates/detect';

/**
 * Rule wrapper around the cross-entity duplicate detector for the
 * cross-account case. Delegates to `detectCrossAuditDuplicates` and
 * filters down to the across-accounts findings only.
 *
 * See the within-audit sibling for shared notes on the detector contract.
 */
export const duplicateChargeAcrossAccountsRule: Rule = {
  id: DUPLICATE_RULE_IDS.across,
  title: 'Duplicate feature charges billed across two accounts',
  appliesTo: 'all',
  evaluate: ({ bill }): Finding[] => {
    const input = buildDetectorInput(bill);
    const all = detectCrossAuditDuplicates(input);
    return all.filter((f) => f.rule_id === DUPLICATE_RULE_IDS.across);
  },
};
