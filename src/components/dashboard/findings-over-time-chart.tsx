import {
  aggregateFindingsOverTime,
  SEVERITY_ORDER,
  type AuditMini,
  type FindingMini,
  type Severity,
} from '@/lib/dashboard/findings-over-time';

/**
 * Findings-over-time mini chart.
 *
 * Vertical stacked-bar SVG, one column per completed audit (most recent
 * 6, oldest left → newest right). Each stack is high/medium/low/info from
 * bottom → top. Bars share a y-scale = max(total findings) across the
 * window so columns are visually comparable.
 *
 * Hidden when fewer than 2 completed audits exist — a single column is
 * structurally similar to the "high-severity findings" stat tile and
 * doesn't add signal here.
 *
 * Pure SVG; bar widths and offsets are computed from constants so we don't
 * need a chart library or runtime measurement. The viewBox uses arbitrary
 * "chart units" (one bar slot wide per column + gutter), and CSS controls
 * the rendered pixel size.
 */

const SEVERITY_COLORS: Record<Severity, string> = {
  high: '#dc2626', // red-600
  medium: '#d97706', // amber-600
  low: '#2563eb', // blue-600
  info: '#9ca3af', // neutral-400
};

const SEVERITY_LABELS: Record<Severity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

// Chart unit geometry. The viewBox is `WIDTH x HEIGHT` and SVG scales to the
// container via `preserveAspectRatio="none"` + `width="100%"`.
const COLUMN_WIDTH = 24;
const COLUMN_GUTTER = 12;
const CHART_HEIGHT = 140;
const X_AXIS_HEIGHT = 18; // space below bars for the date label

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export interface FindingsOverTimeChartProps {
  audits: ReadonlyArray<AuditMini>;
  findings: ReadonlyArray<FindingMini>;
}

export function FindingsOverTimeChart({
  audits,
  findings,
}: FindingsOverTimeChartProps): React.JSX.Element | null {
  // Spec: hide when < 2 completed audits — single bar is low-signal.
  if (audits.length < 2) return null;

  const rows = aggregateFindingsOverTime(audits, findings);
  if (rows.length < 2) return null;

  const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 0);

  const viewWidth = rows.length * COLUMN_WIDTH + (rows.length - 1) * COLUMN_GUTTER;
  const viewHeight = CHART_HEIGHT + X_AXIS_HEIGHT;
  const barAreaHeight = CHART_HEIGHT - 4; // tiny breathing room above tallest bar

  return (
    <section
      aria-label="Findings over time"
      className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Findings over the last {rows.length} audits
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Each column is one completed audit, stacked by severity.
          </p>
        </div>
        <ul
          aria-label="Severity legend"
          className="flex flex-wrap items-center gap-3 text-xs text-neutral-600"
        >
          {SEVERITY_ORDER.map((sev) => (
            <li key={sev} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-sm"
                style={{ backgroundColor: SEVERITY_COLORS[sev] }}
              />
              {SEVERITY_LABELS[sev]}
            </li>
          ))}
        </ul>
      </div>

      <svg
        role="img"
        aria-label="Stacked bar chart of findings by severity across the most recent audits"
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="none"
        className="h-40 w-full"
      >
        {rows.map((row, columnIndex) => {
          const x = columnIndex * (COLUMN_WIDTH + COLUMN_GUTTER);
          // When maxTotal is 0 (every column has zero findings), each column
          // collapses to a flat baseline rather than dividing by zero.
          const scale = maxTotal > 0 ? barAreaHeight / maxTotal : 0;

          // Build stack from bottom (high) up to top (info).
          let cursorY = CHART_HEIGHT;
          const segments = SEVERITY_ORDER.map((sev) => {
            const count = row.counts[sev];
            const height = count * scale;
            cursorY -= height;
            return { sev, count, y: cursorY, height };
          });

          const titleParts = SEVERITY_ORDER.map(
            (sev) => `${SEVERITY_LABELS[sev]}: ${row.counts[sev]}`,
          );
          const titleText = `${formatShortDate(row.created_at)} — ${titleParts.join(', ')} (total ${row.total})`;

          return (
            <g key={row.audit_id}>
              <title>{titleText}</title>
              {/* Baseline tick so empty columns are still visible */}
              <line
                x1={x}
                x2={x + COLUMN_WIDTH}
                y1={CHART_HEIGHT}
                y2={CHART_HEIGHT}
                stroke="#e5e7eb"
                strokeWidth={1}
              />
              {segments.map((seg) =>
                seg.height > 0 ? (
                  <rect
                    key={seg.sev}
                    x={x}
                    y={seg.y}
                    width={COLUMN_WIDTH}
                    height={seg.height}
                    fill={SEVERITY_COLORS[seg.sev]}
                  />
                ) : null,
              )}
              <text
                x={x + COLUMN_WIDTH / 2}
                y={CHART_HEIGHT + X_AXIS_HEIGHT - 4}
                textAnchor="middle"
                fontSize={10}
                fill="#6b7280"
              >
                {formatShortDate(row.created_at)}
              </text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}
