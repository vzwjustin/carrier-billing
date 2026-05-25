/**
 * Renewal Advisor — expiring-contracts helper.
 *
 * Pure function. Takes the user's contract rows and returns the subset whose
 * `expiration_date` falls within `withinDays` of `today`, sorted by date asc.
 * Contracts already expired (delta < 0) and contracts with no expiration_date
 * are excluded.
 *
 * Boundary semantics mirror `expiresWithinDays` in @/rules/helpers — inclusive
 * on both ends (today and the day exactly `withinDays` out both match).
 *
 * Used by /src/app/(app)/renewal-advisor/page.tsx.
 */
import { differenceInCalendarDays, parseISO } from 'date-fns';

/**
 * Shape consumed from the `contracts` table. A narrow subset of the columns
 * — the page picks these explicitly when SELECTing so RLS-scoped queries
 * stay cheap.
 */
export interface ContractRow {
  id: string;
  original_filename: string;
  carrier: string | null;
  ban_last4: string | null;
  expiration_date: string | null;
  /** From the joined contract_terms row — null when no terms exist yet. */
  contracted_monthly_rate_cents: number | null;
}

/**
 * Output shape: input row plus the precomputed days-until-expiration count.
 * Always non-negative (we drop already-expired contracts).
 */
export interface ExpiringContractRow extends ContractRow {
  days_until_expiration: number;
}

/**
 * Returns the subset of `contracts` whose `expiration_date` is within
 * `withinDays` days of `today` (inclusive on both ends), sorted by
 * `days_until_expiration` ascending. Contracts already expired or missing an
 * `expiration_date` are excluded.
 */
export function findExpiringContracts(
  contracts: ReadonlyArray<ContractRow>,
  today: Date,
  withinDays = 90,
): ExpiringContractRow[] {
  const rows: ExpiringContractRow[] = [];
  for (const c of contracts) {
    if (c.expiration_date === null) continue;
    const delta = differenceInCalendarDays(parseISO(c.expiration_date), today);
    if (delta < 0 || delta > withinDays) continue;
    rows.push({ ...c, days_until_expiration: delta });
  }
  rows.sort((a, b) => {
    if (a.days_until_expiration !== b.days_until_expiration) {
      return a.days_until_expiration - b.days_until_expiration;
    }
    // Stable tiebreaker: id so the ordering is deterministic across calls.
    return a.id.localeCompare(b.id);
  });
  return rows;
}
