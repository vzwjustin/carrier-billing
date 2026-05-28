import {
  aggregateSpendByCarrier,
  type AuditCarrierSpendInput,
  type CarrierSpendRow,
} from '@/lib/dashboard/spend-by-carrier';
import { formatCents } from '@/lib/utils';

/**
 * Spend-by-carrier mini chart.
 *
 * Horizontal bars in plain SVG, one per carrier, sorted by total cents desc
 * (aggregator handles sort). Each bar carries a `<title>` for accessibility
 * and a human label/$/% row beneath it. No chart library, no canvas.
 *
 * Hidden (renders `null`) when:
 *   - There are zero audits OR
 *   - Every audit's `total_charges_cents` is null (no signal)
 *
 * Layout sizes: bar width is a percentage of the row's container width so the
 * chart re-flows responsively. The longest bar maps to 100% — the rest scale
 * proportionally vs. the leader, not vs. the fleet total, so smaller carriers
 * remain visible even when one carrier dominates.
 */

const CARRIER_LABELS: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  uscellular: 'US Cellular',
  spectrum: 'Spectrum',
  xfinity: 'Xfinity',
  cricket: 'Cricket',
  unknown: 'Unknown',
};

// Distinct, accessible-against-white palette. Falls back to neutral for any
// new carriers we don't have a colour for yet (forward-compat with migrations
// past 0032). Colours intentionally desaturated to read as data, not branding.
const CARRIER_COLORS: Record<string, string> = {
  verizon: '#dc2626', // red-600
  att: '#2563eb', // blue-600
  tmobile: '#db2777', // pink-600
  uscellular: '#0891b2', // cyan-600
  spectrum: '#7c3aed', // violet-600
  xfinity: '#ea580c', // orange-600
  cricket: '#16a34a', // green-600
  unknown: '#6b7280', // neutral-500
};

function carrierLabel(carrier: string): string {
  return CARRIER_LABELS[carrier] ?? carrier;
}

function carrierColor(carrier: string): string {
  return CARRIER_COLORS[carrier] ?? '#6b7280';
}

export interface SpendByCarrierChartProps {
  audits: ReadonlyArray<AuditCarrierSpendInput>;
}

export function SpendByCarrierChart({
  audits,
}: SpendByCarrierChartProps): React.JSX.Element | null {
  if (audits.length === 0) return null;
  if (audits.every((a) => a.total_charges_cents === null)) return null;

  const rows: CarrierSpendRow[] = aggregateSpendByCarrier(audits);
  if (rows.length === 0) return null;

  // Scale bar widths against the largest carrier — keeps small carriers
  // visible even when one dominates the fleet.
  const maxCents = rows.reduce((m, r) => Math.max(m, r.total_cents), 0);
  if (maxCents <= 0) return null;

  return (
    <section
      aria-label="Spend by carrier"
      className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <div className="mb-4">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Spend by carrier
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          Total billed spend across every uploaded bill, by carrier.
        </p>
      </div>

      <ul role="list" className="space-y-3">
        {rows.map((row) => {
          const widthPct = Math.max(1, (row.total_cents / maxCents) * 100);
          const sharePct = Math.round(row.share * 100);
          const label = carrierLabel(row.carrier);
          const color = carrierColor(row.carrier);
          return (
            <li key={row.carrier}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium text-neutral-900">{label}</span>
                <span className="tabular-nums text-neutral-700">
                  {formatCents(row.total_cents)}
                  <span className="ml-2 text-xs text-neutral-500">
                    {sharePct}%
                  </span>
                </span>
              </div>
              <svg
                role="img"
                aria-label={`${label}: ${formatCents(row.total_cents)} (${sharePct}% of fleet spend)`}
                viewBox="0 0 100 8"
                preserveAspectRatio="none"
                className="mt-1 h-2 w-full rounded-full bg-neutral-100"
              >
                <title>
                  {`${label}: ${formatCents(row.total_cents)} (${sharePct}% of fleet spend)`}
                </title>
                <rect
                  x={0}
                  y={0}
                  width={widthPct}
                  height={8}
                  fill={color}
                  rx={4}
                  ry={4}
                />
              </svg>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
