import type { Rule, Finding } from '../types';
import {
  buildDetectorInput,
  detectCrossAuditDuplicates,
  DUPLICATE_RULE_IDS,
} from '@/duplicates/detect';

/**
 * Rule wrapper around the cross-entity duplicate detector for the
 * single-account case. Delegates to `detectCrossAuditDuplicates` and
 * filters down to the within-audit findings only.
 *
 * The detector itself emits BOTH `duplicate_charge_within_audit` and
 * `duplicate_charge_across_accounts` findings in one pass; the rule
 * registry exposes them as two distinct rule ids so the runner can
 * isolate per-rule errors and the report UI can sort/badge them
 * separately. Both wrappers call the same detector — the work runs
 * once per rule but stays cheap (O(features)).
 */
export const duplicateChargeWithinAuditRule: Rule = {
  id: DUPLICATE_RULE_IDS.within,
  title: 'Duplicate feature charges billed within a single account',
  appliesTo: 'all',
  evaluate: ({ bill }): Finding[] => {
    const input = buildDetectorInput(bill);
    const all = detectCrossAuditDuplicates(input);
    return all.filter((f) => f.rule_id === DUPLICATE_RULE_IDS.within);
  },
};
