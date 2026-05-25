import { differenceInCalendarDays, differenceInCalendarMonths, parseISO } from 'date-fns';
import type {
  Carrier,
  ExtractedFeature,
  ExtractedLine,
  FeatureCategory,
} from '@/extraction/schema';

export { formatCents } from '@/lib/utils';

/** Coerce a Date | ISO-date string into a Date. */
function toDate(input: Date | string): Date {
  return typeof input === 'string' ? parseISO(input) : input;
}

/**
 * Whole-month difference between `date` and `today`. Negative if `date` is
 * already in the past.
 */
export function monthsUntil(date: Date | string, today: Date): number {
  return differenceInCalendarMonths(toDate(date), today);
}

/** Whole-day difference between `date` and `today`. Negative if past. */
export function daysUntil(date: Date | string, today: Date): number {
  return differenceInCalendarDays(toDate(date), today);
}

/** True iff `date` is strictly before `today` (start-of-day comparison). */
export function isExpired(date: Date | string | null, today: Date): boolean {
  if (date === null) return false;
  return daysUntil(date, today) < 0;
}

/**
 * True iff `date` is in the next `days` days inclusive of today, AND not
 * already expired. Returns false for null.
 */
export function expiresWithinDays(
  date: Date | string | null,
  today: Date,
  days: number,
): boolean {
  if (date === null) return false;
  const delta = daysUntil(date, today);
  return delta >= 0 && delta <= days;
}

/** Filter line.features down to a single category. */
export function findFeatureByCategory(
  line: ExtractedLine,
  category: FeatureCategory,
): ExtractedFeature[] {
  return line.features.filter((f) => f.category === category);
}

/** Test a plan name against a list of "deprecated" regex patterns. */
export function isPlanNameDeprecated(
  planName: string | null,
  patterns: RegExp[],
): boolean {
  if (planName === null) return false;
  return patterns.some((re) => re.test(planName));
}

const HOTSPOT_DEVICE_RE = /\b(jetpack|mifi|hotspot|inseego|nighthawk)\b/i;

/** Heuristic: does the device name look like a hotspot/MiFi/Jetpack? */
export function isHotspotDevice(device: string | null): boolean {
  if (device === null) return false;
  return HOTSPOT_DEVICE_RE.test(device);
}

/**
 * A deprecated/legacy plan pattern paired with its modern replacement and a
 * conservative monthly-savings estimate per affected line.
 */
export type LegacyPlanPattern = {
  carrier: Carrier | 'all';
  pattern: RegExp;
  replacement_plan: string;
  estimated_monthly_savings_cents: number;
  source_note: string;
};

// Savings model: $5–$15/mo per line moving from a legacy/grandfathered tier to
// the current carrier-equivalent business unlimited tier. Numbers are
// intentionally conservative — actual delta depends on the customer's chosen
// replacement tier, line-count discount band, and whether the legacy plan
// carried a frozen-rate grandfathered price. Source URLs in source_note.
export const LEGACY_PLAN_PATTERNS: LegacyPlanPattern[] = [
  // Verizon — verizon.com/support/no-longer-supported-plans/
  {
    carrier: 'verizon',
    pattern: /More\s*Everything/i,
    replacement_plan: 'Business Unlimited Plus 2.0',
    estimated_monthly_savings_cents: 1000,
    source_note: 'verizon.com/support/no-longer-supported-plans',
  },
  // "Verizon Plan Unlimited" but NOT current "Verizon Plan Unlimited Pro/Plus/Start".
  // Anchor with \b on both ends and require either end-of-string, whitespace,
  // or a known modifier — this prevents accidental matches against future SKUs
  // that happen to share the prefix (e.g. "Verizon Plan Unlimited Edge").
  {
    carrier: 'verizon',
    pattern:
      /\bVerizon\s+Plan\s+Unlimited\b(?!\s+(Pro|Plus|Start|Edge|Premium|Ultimate))/i,
    replacement_plan: 'Business Unlimited Plus 2.0',
    estimated_monthly_savings_cents: 800,
    source_note: 'verizon.com/support/verizon-plan-unlimited-faqs',
  },
  {
    carrier: 'verizon',
    pattern: /Nationwide\s+\d+/i,
    replacement_plan: 'Business Unlimited Start 2.0',
    estimated_monthly_savings_cents: 1500,
    source_note: 'verizon.com/support/no-longer-supported-plans',
  },
  {
    carrier: 'verizon',
    pattern: /Single\s+Line\s+Plan/i,
    replacement_plan: 'Business Unlimited Start 2.0',
    estimated_monthly_savings_cents: 700,
    source_note: 'verizon.com/support/no-longer-supported-plans',
  },

  // AT&T — att.com/support/article/wireless/KM1119192 + retired Mobile Share PDFs
  // "Mobile Share" but NOT current "Mobile Share Plus" / "Mobile Share Premium"
  {
    carrier: 'att',
    pattern: /Mobile\s*Share(?!\s+(Plus|Premium))/i,
    replacement_plan: 'Business Unlimited Performance',
    estimated_monthly_savings_cents: 1000,
    source_note: 'business.att.com/legal/mobile-share-for-business-retired',
  },
  {
    carrier: 'att',
    pattern: /Family\s*Talk/i,
    replacement_plan: 'Business Unlimited Starter',
    estimated_monthly_savings_cents: 500,
    source_note: 'att.com/support/article/wireless/KM1119192',
  },
  {
    carrier: 'att',
    pattern: /Nation\s+\d+/i,
    replacement_plan: 'Business Unlimited Starter',
    estimated_monthly_savings_cents: 500,
    source_note: 'att.com/support/article/wireless/KM1119192',
  },
  // Legacy "Unlimited Plus" (consumer) but NOT the "Unlimited Plus for iPhone" bundle
  {
    carrier: 'att',
    pattern: /Unlimited\s+Plus(?!\s+for\s+iPhone)/i,
    replacement_plan: 'Business Unlimited Premium',
    estimated_monthly_savings_cents: 800,
    source_note: 'att.com/support/article/wireless/KM1119192',
  },

  // T-Mobile — t-mobile.com/community grandfathered-plan-changes
  {
    carrier: 'tmobile',
    pattern: /Simple\s+Choice/i,
    replacement_plan: 'Business Unlimited Advanced',
    estimated_monthly_savings_cents: 800,
    source_note: 't-mobile.com/community/grandfathered-plan-changes',
  },
  // "Magenta" but NOT current "Magenta Plus" / "Magenta Max" / "Magenta Business"
  // and NOT future SKUs that happen to start with "Magenta" (Magenta 55+,
  // Magenta Military, Magenta First Responder are existing carrier-modifier
  // SKUs that should NOT be flagged as legacy).
  {
    carrier: 'tmobile',
    pattern:
      /\bMagenta\b(?!\s+(Plus|Max|Business|55\+|Military|First Responder))/i,
    replacement_plan: 'Business Unlimited Advanced',
    estimated_monthly_savings_cents: 700,
    source_note: 'phonearena.com/news/i-just-ditched-my-grandfathered-t-mobile-magenta-plan',
  },
  {
    carrier: 'tmobile',
    pattern: /T-Mobile\s+ONE(?!\s+Business)/i,
    replacement_plan: 'Business Unlimited Advanced',
    estimated_monthly_savings_cents: 700,
    source_note: 'phonearena.com/news/t-mobile-legacy-plan-migration-2026',
  },

  // US Cellular — uscellular.com/plans (modern Business Unlimited family
  // replaces the long-retired Belief / Payback consumer tiers).
  {
    carrier: 'uscellular',
    pattern: /Belief\s+Plan/i,
    replacement_plan: 'Business Unlimited Everyday',
    estimated_monthly_savings_cents: 1000,
    source_note: 'uscellular.com/support/legacy-plans',
  },
  {
    carrier: 'uscellular',
    pattern: /Unlimited\s+with\s+Payback/i,
    replacement_plan: 'Business Unlimited Everyday',
    estimated_monthly_savings_cents: 800,
    source_note: 'uscellular.com/support/legacy-plans',
  },

  // Spectrum Mobile — spectrum.com/mobile (consumer-tier "Unlimited Plus"
  // still appears on small-business accounts that ported in pre-2024).
  {
    carrier: 'spectrum',
    pattern: /Unlimited\s+Plus/i,
    replacement_plan: 'Spectrum Business Unlimited',
    estimated_monthly_savings_cents: 700,
    source_note: 'spectrum.com/mobile/plans',
  },

  // Xfinity Mobile — xfinity.com/mobile/plan (the "By the Gig" metered tier
  // is a hold-over from the original 2017 launch — modern Unlimited is
  // cheaper above ~3 GB/mo of usage).
  {
    carrier: 'xfinity',
    pattern: /By\s+the\s+Gig/i,
    replacement_plan: 'Xfinity Mobile Unlimited',
    estimated_monthly_savings_cents: 500,
    source_note: 'xfinity.com/mobile/plan',
  },

  // Cricket Wireless — cricketwireless.com/cell-phone-plans (the legacy
  // "Cricket More" mid-tier was retired in favor of the simpler Core /
  // Smart / Elite ladder).
  {
    carrier: 'cricket',
    pattern: /Cricket\s+More/i,
    replacement_plan: 'Cricket Smart',
    estimated_monthly_savings_cents: 500,
    source_note: 'cricketwireless.com/cell-phone-plans',
  },
];

function patternsForCarrier(carrier: Carrier): LegacyPlanPattern[] {
  if (carrier === 'unknown') return LEGACY_PLAN_PATTERNS;
  return LEGACY_PLAN_PATTERNS.filter(
    (p) => p.carrier === carrier || p.carrier === 'all',
  );
}

/**
 * Returns the legacy-plan regex set for a given carrier. For 'unknown' or
 * when running rules carrier-agnostically, callers fall through to the union
 * of all sets.
 */
export function getCarrierPlanPatterns(carrier: Carrier): RegExp[] {
  return patternsForCarrier(carrier).map((p) => p.pattern);
}

/**
 * Finds the first legacy-plan entry whose regex matches `planName`, or null.
 * Carrier-scoped: passing 'unknown' searches the union of all sets.
 */
export function findMatchingLegacyPlan(
  planName: string | null,
  carrier: Carrier,
): LegacyPlanPattern | null {
  if (planName === null) return null;
  return patternsForCarrier(carrier).find((p) => p.pattern.test(planName)) ?? null;
}

/**
 * Group a feature list by category. All categories are present in the
 * returned record (empty arrays for categories with no features) so callers
 * don't have to null-check.
 */
export function categorizeFeatureSet(
  features: ExtractedFeature[],
): Record<FeatureCategory, ExtractedFeature[]> {
  const empty: Record<FeatureCategory, ExtractedFeature[]> = {
    insurance: [],
    international: [],
    cloud: [],
    hotspot: [],
    addon: [],
    other: [],
  };
  for (const f of features) {
    empty[f.category].push(f);
  }
  return empty;
}
