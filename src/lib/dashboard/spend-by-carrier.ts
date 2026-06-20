/**
 * Spend-by-carrier aggregator.
 *
 * Pure function — takes a list of mini audit rows (one per audit) and rolls
 * up `total_charges_cents` by `carrier`. Lines whose total is null are
 * stripped entirely (we don't want to invent zero spend for a carrier that
 * may just be missing data); a null/empty carrier with a real total falls
 * under the literal `'unknown'` bucket so it still appears in the chart.
 *
 * Used by:
 *   - /src/app/(app)/dashboard/page.tsx → <SpendByCarrierChart />
 *
 * Mirrors the shape of `aggregateCostCenters` in /src/lib/cost-centers — the
 * dashboard exclusively renders `CarrierSpendRow[]` from this output.
 */

export interface AuditCarrierSpendInput {
  /** Carrier slug as stored on `audits.carrier`. NULL → 'unknown'. */
  carrier: string | null;
  /** Total monthly charges in cents for the bill. NULL audits are excluded. */
  total_charges_cents: number | null;
}

export interface CarrierSpendRow {
  carrier: string;
  total_cents: number;
  /** 0..1 share of fleet spend across all carriers. 0 if fleet total is 0. */
  share: number;
}

const UNKNOWN_CARRIER = 'unknown';

/**
 * Aggregate audit totals by `carrier`. Null totals are dropped so a missing
 * extraction doesn't masquerade as $0 of spend for a carrier. Sort order is
 * total_cents desc, then alphabetical by carrier slug to keep stable output.
 *
 * Returns an empty array if no audit has a non-null total — the chart is
 * hidden in that case (signal-less).
 */
export function aggregateSpendByCarrier(
  audits: ReadonlyArray<AuditCarrierSpendInput>,
): CarrierSpendRow[] {
  const buckets = new Map<string, number>();
  let total = 0;

  for (const audit of audits) {
    if (audit.total_charges_cents === null) continue;
    const carrier =
      audit.carrier === null || audit.carrier.trim() === '' ? UNKNOWN_CARRIER : audit.carrier;
    buckets.set(carrier, (buckets.get(carrier) ?? 0) + audit.total_charges_cents);
    total += audit.total_charges_cents;
  }

  // ⚡ Bolt: Use map function in Array.from to prevent intermediate array allocation
  const rows: CarrierSpendRow[] = Array.from(buckets.entries(), ([carrier, total_cents]) => ({
    carrier,
    total_cents,
    share: total > 0 ? total_cents / total : 0,
  }));

  rows.sort((a, b) => {
    if (b.total_cents !== a.total_cents) return b.total_cents - a.total_cents;
    return a.carrier.localeCompare(b.carrier);
  });

  return rows;
}
