import type { CarrierMapHooks } from '@/extraction/edi811/mapper';
import type { FeatureCategory } from '@/extraction/schema';

/** T-Mobile 811 quirks. Mirrors `src/extraction/carriers/tmobile.ts`. */

const PLAN_PATTERNS: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /business\s+unlimited\s+ultimate/i, canonical: 'Business Unlimited Ultimate' },
  { pattern: /business\s+unlimited\s+advanced/i, canonical: 'Business Unlimited Advanced' },
  { pattern: /business\s+unlimited\s+select/i, canonical: 'Business Unlimited Select' },
];

const FEATURE_CATEGORIES: Array<{ pattern: RegExp; category: FeatureCategory }> = [
  {
    pattern: /(protection\s*<?\s*360\s*>?|premium\s+handset\s+protection)/i,
    category: 'insurance',
  },
  { pattern: /magenta\s+international/i, category: 'international' },
];

export const TMOBILE_HOOKS: CarrierMapHooks = {
  feature: ({ description, serviceIdCode }) => {
    for (const { pattern, category } of FEATURE_CATEGORIES) {
      if (pattern.test(description)) {
        return { name: description, category };
      }
    }
    return { name: description || `Service ${serviceIdCode}`, category: 'other' };
  },
  // T-Mobile labels promotional credits as "Bill Credit" inconsistently — force
  // the promo flag on if the description mentions bill credit, matching the
  // PDF normalizer's contract.
  credit: ({ description, isPromo, serviceIdCode }) => {
    const trimmed = (description ?? '').trim();
    const isBillCredit = /\bbill\s+credit\b/i.test(trimmed);
    return {
      name: trimmed || `Credit ${serviceIdCode}`,
      isPromo: isBillCredit ? true : isPromo,
    };
  },
  planName: ({ description, productId }) => {
    const candidate = (description || productId || '').trim();
    if (candidate.length === 0) return null;
    for (const { pattern, canonical } of PLAN_PATTERNS) {
      if (pattern.test(candidate)) return canonical;
    }
    return candidate;
  },
};
