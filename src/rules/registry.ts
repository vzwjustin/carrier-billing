import type { Rule } from './types';
import type { Carrier } from '@/extraction/schema';
import { CarrierSchema } from '@/extraction/schema';
import {
  expiredPromoCreditRule,
  completedDevicePaymentRule,
  orphanInsuranceRule,
  staleInternationalFeatureRule,
  unusedMifiLineRule,
  suspendedLineBilledRule,
  legacyUnlimitedPlanRule,
  dataOveragePatternRule,
  duplicateProtectionFeaturesRule,
  accountPromoExpiringSoonRule,
  insuranceAfterDevicePayoffRule,
  underutilizedPhoneOnPremiumPlanRule,
  disproportionateTaxesFeesRule,
  activationFeeOnExistingLineRule,
  strandedCloudStorageRule,
} from './definitions';

export const ALL_RULES: Rule[] = [
  expiredPromoCreditRule,
  completedDevicePaymentRule,
  orphanInsuranceRule,
  staleInternationalFeatureRule,
  unusedMifiLineRule,
  suspendedLineBilledRule,
  legacyUnlimitedPlanRule,
  dataOveragePatternRule,
  duplicateProtectionFeaturesRule,
  accountPromoExpiringSoonRule,
  insuranceAfterDevicePayoffRule,
  underutilizedPhoneOnPremiumPlanRule,
  disproportionateTaxesFeesRule,
  activationFeeOnExistingLineRule,
  strandedCloudStorageRule,
];

const VALID_CARRIERS = new Set<Carrier>(CarrierSchema.options);

/**
 * Runtime self-check on the rule registry. Runs at module load so registry
 * mistakes (duplicate ids, blank titles, unknown carriers in `appliesTo`)
 * fail the import rather than silently corrupting findings at runtime.
 *
 * Exported for tests; do NOT call from rule code.
 */
export function validateRegistry(rules: Rule[] = ALL_RULES): void {
  const seenIds = new Set<string>();
  for (const rule of rules) {
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      throw new Error(
        `[rules] registry: rule "${rule.title ?? '<unknown>'}" has an empty id`,
      );
    }
    if (seenIds.has(rule.id)) {
      throw new Error(
        `[rules] registry: duplicate rule id "${rule.id}" — every rule must have a unique id`,
      );
    }
    seenIds.add(rule.id);

    if (typeof rule.title !== 'string' || rule.title.trim().length === 0) {
      throw new Error(
        `[rules] registry: rule "${rule.id}" has an empty title`,
      );
    }

    const applies = rule.appliesTo;
    if (applies === 'all') continue;
    if (!Array.isArray(applies)) {
      throw new Error(
        `[rules] registry: rule "${rule.id}" appliesTo must be 'all' or an array of carriers`,
      );
    }
    if (applies.length === 0) {
      throw new Error(
        `[rules] registry: rule "${rule.id}" appliesTo is an empty array — use 'all' for all carriers`,
      );
    }
    for (const carrier of applies) {
      if (!VALID_CARRIERS.has(carrier)) {
        throw new Error(
          `[rules] registry: rule "${rule.id}" appliesTo contains unknown carrier "${String(carrier)}"`,
        );
      }
    }
  }
}

// Run at module load — fail fast on registry mistakes instead of silently
// running an inconsistent set of rules.
validateRegistry();
