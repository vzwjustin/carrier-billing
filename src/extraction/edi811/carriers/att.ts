import type { CarrierMapHooks } from '@/extraction/edi811/mapper';
import type { FeatureCategory } from '@/extraction/schema';

/** AT&T 811 quirks. Mirrors `src/extraction/carriers/att.ts`. */

const PLAN_PATTERNS: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /business\s+unlimited\s+premium/i, canonical: 'Business Unlimited Premium' },
  { pattern: /business\s+unlimited\s+performance/i, canonical: 'Business Unlimited Performance' },
  { pattern: /business\s+unlimited\s+starter/i, canonical: 'Business Unlimited Starter' },
];

const FEATURE_CATEGORIES: Array<{ pattern: RegExp; category: FeatureCategory }> = [
  {
    pattern: /(at\s*&\s*t\s+mobile\s+insurance|mobile\s+protection\s+pack)/i,
    category: 'insurance',
  },
  { pattern: /international\s+day\s+pass/i, category: 'international' },
  { pattern: /at\s*&\s*t\s+photo\s+storage/i, category: 'cloud' },
];

export const ATT_HOOKS: CarrierMapHooks = {
  feature: ({ description, serviceIdCode }) => {
    for (const { pattern, category } of FEATURE_CATEGORIES) {
      if (pattern.test(description)) {
        return { name: description, category };
      }
    }
    return { name: description || `Service ${serviceIdCode}`, category: 'other' };
  },
  credit: ({ description, isPromo, serviceIdCode }) => ({
    name: (description ?? '').trim() || `Credit ${serviceIdCode}`,
    isPromo,
  }),
  planName: ({ description, productId }) => {
    const candidate = (description || productId || '').trim();
    if (candidate.length === 0) return null;
    for (const { pattern, canonical } of PLAN_PATTERNS) {
      if (pattern.test(candidate)) return canonical;
    }
    return candidate;
  },
};
