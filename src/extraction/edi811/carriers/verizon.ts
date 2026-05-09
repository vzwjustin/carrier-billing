import type { CarrierMapHooks } from '@/extraction/edi811/mapper';
import type { FeatureCategory } from '@/extraction/schema';

/**
 * Verizon Wireless 811 quirks. Mirrors the PDF carrier normalizer in
 * `src/extraction/carriers/verizon.ts` so the rules engine sees the same
 * canonical plan names + feature categories regardless of ingest source.
 */

const PLAN_PATTERNS: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /pro\s*2\.?0/i, canonical: 'Business Unlimited Pro 2.0' },
  { pattern: /plus\s*2\.?0/i, canonical: 'Business Unlimited Plus 2.0' },
  { pattern: /start\s*2\.?0/i, canonical: 'Business Unlimited Start 2.0' },
];

const FEATURE_CATEGORIES: Array<{ pattern: RegExp; category: FeatureCategory }> = [
  { pattern: /verizon\s+cloud/i, category: 'cloud' },
  { pattern: /travel\s*pass/i, category: 'international' },
  {
    pattern: /(mobile\s+protect|total\s+mobile\s+protection|wireless\s+phone\s+protection)/i,
    category: 'insurance',
  },
];

export const VERIZON_HOOKS: CarrierMapHooks = {
  feature: ({ description, serviceIdCode }) => {
    for (const { pattern, category } of FEATURE_CATEGORIES) {
      if (pattern.test(description)) {
        return { name: description, category };
      }
    }
    // Verizon's BU240–BU299 codes denote bundled feature add-ons.
    if (/^BU2\d{2}$/i.test(serviceIdCode)) {
      return { name: description || serviceIdCode, category: 'addon' };
    }
    return { name: description || `Service ${serviceIdCode}`, category: 'other' };
  },
  credit: ({ description, isPromo, serviceIdCode }) => {
    const trimmed = (description ?? '').trim();
    const name = /^loyalty\s+discount$/i.test(trimmed)
      ? 'Loyalty Discount'
      : trimmed || `Credit ${serviceIdCode}`;
    return { name, isPromo };
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
