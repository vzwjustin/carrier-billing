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

/**
 * Net monthly charge for a line: plan + features + DPP installments minus
 * any (signed) credits. Credits already carry their sign on the bill.
 */
export function sumLineCharges(line: ExtractedLine): number {
  const base = line.plan_base_cents ?? 0;
  const features = line.features.reduce((sum, f) => sum + f.monthly_cents, 0);
  const dpp = line.dpp_installments.reduce((sum, d) => sum + d.monthly_cents, 0);
  // Credits on the bill are typically negative; preserve sign.
  const credits = line.credits.reduce((sum, c) => sum + c.monthly_cents, 0);
  return base + features + dpp + credits;
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
 * Per-carrier patterns matching legacy/deprecated plan names. Used by the
 * `legacy_unlimited_plan` rule. Patterns are intentionally narrow: they must
 * not match any current business unlimited tier on each carrier.
 *
 * TODO(domain): Justin to validate regex set + add savings model when
 * modern-equivalent plan price is known per carrier.
 */
const VERIZON_LEGACY_PATTERNS: RegExp[] = [
  /More\s*Everything/i,
  // Match "Verizon Plan Unlimited" but NOT the current "Business Unlimited
  // Pro/Plus/Start 2.0" tiers.
  /Verizon\s+Plan\s+Unlimited(?!\s+(Pro|Plus|Start))/i,
  /Nationwide\s+\d+/i,
  /Single\s+Line\s+Plan/i,
];

const ATT_LEGACY_PATTERNS: RegExp[] = [
  // Match legacy "Mobile Share" but not "Mobile Share Plus" or
  // "Mobile Share Premium" (still active variants).
  /Mobile\s*Share(?!\s+(Plus|Premium))/i,
  /Family\s*Talk/i,
  /Nation\s+\d+/i,
  // Match legacy "Unlimited Plus" (consumer) but not the iPhone bundle.
  /Unlimited\s+Plus(?!\s+for\s+iPhone)/i,
];

const TMOBILE_LEGACY_PATTERNS: RegExp[] = [
  /Simple\s+Choice/i,
  // Match "Magenta" but not "Magenta Plus", "Magenta Max", or
  // "Magenta Business" which are current.
  /Magenta(?!\s+(Plus|Max|Business))/i,
  /T-Mobile\s+ONE(?!\s+Business)/i,
];

/**
 * Returns the legacy-plan regex set for a given carrier. For 'unknown' or
 * when running rules carrier-agnostically, callers should fall through to
 * the union of all sets.
 */
export function getCarrierPlanPatterns(carrier: Carrier): RegExp[] {
  switch (carrier) {
    case 'verizon':
      return VERIZON_LEGACY_PATTERNS;
    case 'att':
      return ATT_LEGACY_PATTERNS;
    case 'tmobile':
      return TMOBILE_LEGACY_PATTERNS;
    case 'unknown':
      return [
        ...VERIZON_LEGACY_PATTERNS,
        ...ATT_LEGACY_PATTERNS,
        ...TMOBILE_LEGACY_PATTERNS,
      ];
  }
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
