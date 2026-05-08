import type { Rule } from './types';
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
];
