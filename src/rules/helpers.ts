import { differenceInCalendarDays, differenceInCalendarMonths, parseISO } from 'date-fns';
import type {
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
