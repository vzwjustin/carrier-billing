/**
 * Executive multi-audit PDF — server-only renderer.
 *
 * Renders an `ExecutiveReportData` to a Buffer using @react-pdf/renderer.
 * Visual style mirrors `src/reports/pdf/document.tsx` — same fonts,
 * palette, and page metrics so a CFO bundle reads as one suite.
 *
 * Determinism: takes the report data as-is. The `generatedAt` value is
 * passed in from the caller (route handler) so caching tests can pin it.
 *
 * PII discipline (CLAUDE.md §1#5): we never embed full phone numbers,
 * user_labels, raw account numbers, or user emails. Aggregates, audit
 * IDs (treated as opaque), and last-4 only.
 */
import 'server-only';

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Svg,
  Rect,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { ReactElement } from 'react';

import { formatCents } from '@/lib/utils';
import { formatIsoDateDisplay, formatIsoDatePeriod } from '@/lib/dates';
import type {
  ExecutiveAuditSummary,
  ExecutiveCategoryRow,
  ExecutiveReportData,
  ExecutiveTopDriver,
  ExecutiveTopFinding,
} from './builder';

// ── Style tokens — kept in lockstep with src/reports/pdf/document.tsx ──
const COLORS = {
  ink: '#0F172A',
  muted: '#64748B',
  subtle: '#94A3B8',
  border: '#E2E8F0',
  page: '#FFFFFF',
  card: '#F8FAFC',
  bar: '#0F172A',
  barFaded: '#CBD5E1',
  positive: '#047857',
  negative: '#B91C1C',
} as const;

const styles = StyleSheet.create({
  page: {
    backgroundColor: COLORS.page,
    color: COLORS.ink,
    fontFamily: 'Helvetica',
    fontSize: 10,
    paddingTop: 48,
    paddingBottom: 56,
    paddingHorizontal: 48,
    lineHeight: 1.4,
  },
  coverWrap: { flex: 1, justifyContent: 'space-between' },
  coverTopBlock: { marginTop: 80 },
  coverEyebrow: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 2,
    color: COLORS.muted,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  coverTitle: {
    fontSize: 42,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    lineHeight: 1.1,
  },
  coverSubtitle: { fontSize: 14, color: COLORS.muted, marginTop: 12 },
  coverHero: {
    marginTop: 40,
    padding: 24,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
  },
  coverHeroLabel: {
    fontSize: 9,
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  coverHeroValue: {
    fontSize: 40,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  coverHeroHelp: { fontSize: 10, color: COLORS.muted, marginTop: 8 },
  coverMetaRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 32 },
  coverMetaItem: { width: '50%', marginBottom: 16 },
  coverMetaLabel: {
    fontSize: 8,
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  coverMetaValue: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  coverFootnote: { fontSize: 9, color: COLORS.subtle },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    marginBottom: 4,
  },
  sectionSubtitle: { fontSize: 10, color: COLORS.muted, marginBottom: 20 },
  groupHeading: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    marginTop: 16,
    marginBottom: 8,
  },
  // Tables
  table: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    marginTop: 8,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  tableHeaderCell: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  tableRowLast: { borderBottomWidth: 0 },
  tableCell: { fontSize: 10, color: COLORS.ink },
  tableCellMuted: { fontSize: 10, color: COLORS.muted },
  positive: { color: COLORS.positive },
  negative: { color: COLORS.negative },
  // Footer / chrome
  footer: {
    position: 'absolute',
    left: 48,
    right: 48,
    bottom: 24,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: COLORS.subtle,
  },
  hr: { height: 1, backgroundColor: COLORS.border, marginVertical: 12 },
  // Bar charts
  barGroup: { marginTop: 8 },
  barLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  barLabel: { fontSize: 9, color: COLORS.muted },
  barValue: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
});

const CARRIER_NAMES: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  unknown: 'Unknown carrier',
};

function carrierName(carrier: string | null): string {
  if (!carrier) return 'Unknown carrier';
  return CARRIER_NAMES[carrier] ?? carrier;
}

function pctLabel(bps: number | null): string {
  if (bps === null) return '—';
  const sign = bps >= 0 ? '+' : '';
  return `${sign}${(bps / 100).toFixed(1)}%`;
}

function severityLabel(s: ExecutiveTopFinding['severity']): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function PageFooter({
  reportId,
  generatedAt,
}: {
  reportId: string;
  generatedAt: string;
}): ReactElement {
  return (
    <View style={styles.footer} fixed>
      <Text>CarrierAudit Executive · {reportId}</Text>
      <Text>{generatedAt}</Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

// ── 1. Cover page ─────────────────────────────────────────────────────
function CoverPage({
  data,
  generatedOn,
}: {
  data: ExecutiveReportData;
  generatedOn: string;
}): ReactElement {
  const oldest = data.audits[data.audits.length - 1];
  const newest = data.audits[0];
  const dateRange =
    oldest && newest
      ? `${formatIsoDateDisplay(oldest.billing_period_start ?? oldest.billing_period_end)} – ${formatIsoDateDisplay(
          newest.billing_period_end ?? newest.billing_period_start,
        )}`
      : '—';

  return (
    <Page size="A4" style={styles.page}>
      <View style={styles.coverWrap}>
        <View style={styles.coverTopBlock}>
          <Text style={styles.coverEyebrow}>CarrierAudit</Text>
          <Text style={styles.coverTitle}>Executive Summary</Text>
          <Text style={styles.coverSubtitle}>
            Wireless billing audit — multi-period view for finance leadership
          </Text>

          <View style={styles.coverHero}>
            <Text style={styles.coverHeroLabel}>Lifetime annual savings identified</Text>
            <Text style={styles.coverHeroValue}>
              {formatCents(data.lifetime.annual_savings_cents)}
            </Text>
            <Text style={styles.coverHeroHelp}>
              Sum of estimated annual savings across the {data.audits.length} most recent completed
              audit{data.audits.length === 1 ? '' : 's'}.
            </Text>
          </View>

          <View style={styles.coverMetaRow}>
            <View style={styles.coverMetaItem}>
              <Text style={styles.coverMetaLabel}>Audits in this report</Text>
              <Text style={styles.coverMetaValue}>{data.audits.length}</Text>
            </View>
            <View style={styles.coverMetaItem}>
              <Text style={styles.coverMetaLabel}>Date range</Text>
              <Text style={styles.coverMetaValue}>{dateRange}</Text>
            </View>
            <View style={styles.coverMetaItem}>
              <Text style={styles.coverMetaLabel}>Total spend reviewed</Text>
              <Text style={styles.coverMetaValue}>
                {formatCents(data.lifetime.total_spend_cents)}
              </Text>
            </View>
            <View style={styles.coverMetaItem}>
              <Text style={styles.coverMetaLabel}>Generated on</Text>
              <Text style={styles.coverMetaValue}>{generatedOn}</Text>
            </View>
          </View>
        </View>

        <View>
          <Text style={styles.coverFootnote}>
            Confidential — prepared for the bill owner. Not affiliated with Verizon, AT&amp;T, or
            T-Mobile.
          </Text>
        </View>
      </View>
      <PageFooter reportId="executive" generatedAt={generatedOn} />
    </Page>
  );
}

// ── 2. Spend trend page ──────────────────────────────────────────────
function TrendPage({
  data,
  generatedOn,
}: {
  data: ExecutiveReportData;
  generatedOn: string;
}): ReactElement {
  // Chart geometry — keep simple so the Svg primitives don't need a lib.
  const chartWidth = 460;
  const chartHeight = 160;
  const padLeft = 8;
  const padRight = 8;
  const innerWidth = chartWidth - padLeft - padRight;
  const innerHeight = chartHeight - 16; // leave 16pt headroom for value labels
  const points = data.trend;
  const max = points.reduce((m, p) => (p.total_charges_cents > m ? p.total_charges_cents : m), 0);
  const slotW = points.length > 0 ? innerWidth / points.length : innerWidth;
  // 60% of the slot width is the bar; 20% padding on each side.
  const barW = slotW * 0.6;
  const barPad = slotW * 0.2;

  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.sectionTitle}>Spend trend</Text>
      <Text style={styles.sectionSubtitle}>Total charges across the audited billing periods.</Text>

      {points.length === 0 ? (
        <Text style={styles.tableCellMuted}>No periods to display.</Text>
      ) : (
        <>
          <Svg width={chartWidth} height={chartHeight}>
            {/* Baseline */}
            <Rect
              x={padLeft}
              y={innerHeight + 0.5}
              width={innerWidth}
              height={1}
              fill={COLORS.border}
            />
            {points.map((p, i) => {
              const h = max > 0 ? (p.total_charges_cents / max) * innerHeight : 0;
              const x = padLeft + i * slotW + barPad;
              const y = innerHeight - h;
              return (
                <Rect
                  key={p.audit_id}
                  x={x}
                  y={y}
                  width={barW}
                  height={Math.max(1, h)}
                  fill={i === points.length - 1 ? COLORS.bar : COLORS.barFaded}
                />
              );
            })}
          </Svg>

          <View style={styles.table}>
            <View style={styles.tableHeader}>
              <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Period ending</Text>
              <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'right' }]}>Total</Text>
              <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'right' }]}>
                Δ vs prior
              </Text>
            </View>
            {points.map((p, i) => (
              <View
                key={p.audit_id}
                style={[styles.tableRow, i === points.length - 1 ? styles.tableRowLast : {}]}
              >
                <Text style={[styles.tableCell, { flex: 2 }]}>
                  {formatIsoDateDisplay(p.billing_period_end)}
                </Text>
                <Text style={[styles.tableCell, { flex: 1, textAlign: 'right' }]}>
                  {formatCents(p.total_charges_cents)}
                </Text>
                <Text
                  style={[
                    styles.tableCell,
                    { flex: 1, textAlign: 'right' },
                    p.percent_change_bps === null
                      ? styles.tableCellMuted
                      : p.percent_change_bps > 0
                        ? styles.negative
                        : p.percent_change_bps < 0
                          ? styles.positive
                          : {},
                  ]}
                >
                  {pctLabel(p.percent_change_bps)}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}

      <Text style={styles.groupHeading}>Audits in this report</Text>
      <AuditTable audits={data.audits} />

      <PageFooter reportId="executive" generatedAt={generatedOn} />
    </Page>
  );
}

function AuditTable({ audits }: { audits: ExecutiveAuditSummary[] }): ReactElement {
  if (audits.length === 0) {
    return <Text style={styles.tableCellMuted}>No audits to display.</Text>;
  }
  return (
    <View style={styles.table}>
      <View style={styles.tableHeader}>
        <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Carrier</Text>
        <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Period</Text>
        <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'right' }]}>Lines</Text>
        <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'right' }]}>Findings</Text>
        <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'right' }]}>Total</Text>
      </View>
      {audits.map((a, i) => (
        <View
          key={a.id}
          style={[styles.tableRow, i === audits.length - 1 ? styles.tableRowLast : {}]}
        >
          <Text style={[styles.tableCell, { flex: 1 }]}>{carrierName(a.carrier)}</Text>
          <Text style={[styles.tableCellMuted, { flex: 2 }]}>
            {formatIsoDatePeriod(a.billing_period_start, a.billing_period_end)}
          </Text>
          <Text style={[styles.tableCell, { flex: 1, textAlign: 'right' }]}>
            {a.line_count.toLocaleString('en-US')}
          </Text>
          <Text style={[styles.tableCell, { flex: 1, textAlign: 'right' }]}>
            {a.finding_count.toLocaleString('en-US')}
          </Text>
          <Text style={[styles.tableCell, { flex: 1, textAlign: 'right' }]}>
            {formatCents(a.total_charges_cents ?? 0)}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ── 3. Top findings page ─────────────────────────────────────────────
function TopFindingsPage({
  data,
  generatedOn,
}: {
  data: ExecutiveReportData;
  generatedOn: string;
}): ReactElement {
  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.sectionTitle}>Top findings</Text>
      <Text style={styles.sectionSubtitle}>
        The five largest monthly-savings opportunities still open across the audits in this report.
      </Text>
      {data.topFindings.length === 0 ? (
        <Text style={styles.tableCellMuted}>No actionable findings across these audits.</Text>
      ) : (
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Severity</Text>
            <Text style={[styles.tableHeaderCell, { flex: 3 }]}>Title</Text>
            <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Category</Text>
            <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'right' }]}>Monthly</Text>
          </View>
          {data.topFindings.map((f, i) => (
            <View
              key={`${f.rule_id}-${i}`}
              style={[
                styles.tableRow,
                i === data.topFindings.length - 1 ? styles.tableRowLast : {},
              ]}
            >
              <Text style={[styles.tableCell, { flex: 1 }]}>{severityLabel(f.severity)}</Text>
              <Text style={[styles.tableCell, { flex: 3 }]}>{f.title}</Text>
              <Text style={[styles.tableCellMuted, { flex: 2 }]}>{f.category_label}</Text>
              <Text style={[styles.tableCell, styles.positive, { flex: 1, textAlign: 'right' }]}>
                {formatCents(f.estimated_monthly_savings_cents)}
              </Text>
            </View>
          ))}
        </View>
      )}
      <PageFooter reportId="executive" generatedAt={generatedOn} />
    </Page>
  );
}

// ── 4. Top autopsy drivers page ──────────────────────────────────────
function TopDriversPage({
  drivers,
  generatedOn,
}: {
  drivers: ExecutiveTopDriver[];
  generatedOn: string;
}): ReactElement {
  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.sectionTitle}>Top bill-change drivers</Text>
      <Text style={styles.sectionSubtitle}>
        The five largest period-over-period swings detected by Bill Increase Autopsy across the
        audits in this report.
      </Text>
      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderCell, { flex: 3 }]}>Driver</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Lines</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'right' }]}>Δ</Text>
        </View>
        {drivers.map((d, i) => (
          <View
            key={`${d.comparison_id}-${i}`}
            style={[styles.tableRow, i === drivers.length - 1 ? styles.tableRowLast : {}]}
          >
            <Text style={[styles.tableCell, { flex: 3 }]}>{d.title}</Text>
            <Text style={[styles.tableCell, { flex: 1 }]}>
              {d.affected_lines_count.toLocaleString('en-US')}
            </Text>
            <Text
              style={[
                styles.tableCell,
                { flex: 1, textAlign: 'right' },
                d.difference_cents > 0
                  ? styles.negative
                  : d.difference_cents < 0
                    ? styles.positive
                    : {},
              ]}
            >
              {d.difference_cents >= 0 ? '+' : '-'}
              {formatCents(Math.abs(d.difference_cents))}
            </Text>
          </View>
        ))}
      </View>
      <PageFooter reportId="executive" generatedAt={generatedOn} />
    </Page>
  );
}

// ── 5. By cost center page ───────────────────────────────────────────
function CostCenterPage({
  rows,
  generatedOn,
}: {
  rows: NonNullable<ExecutiveReportData['byCostCenter']>;
  generatedOn: string;
}): ReactElement {
  const total = rows.reduce((acc, r) => acc + r.monthly_total_cents, 0);
  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.sectionTitle}>Spend by cost center</Text>
      <Text style={styles.sectionSubtitle}>
        Monthly base plan spend grouped by operator-tagged cost center, aggregated across the audits
        in this report.
        {total > 0 ? ` Total: ${formatCents(total)}/mo.` : ''}
      </Text>
      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderCell, { flex: 3 }]}>Cost center</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'right' }]}>Lines</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'right' }]}>Monthly</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'right' }]}>Share</Text>
        </View>
        {rows.map((row, i) => (
          <View
            key={row.cost_center}
            style={[styles.tableRow, i === rows.length - 1 ? styles.tableRowLast : {}]}
          >
            <Text style={[styles.tableCell, { flex: 3 }]}>{row.cost_center}</Text>
            <Text style={[styles.tableCell, { flex: 1, textAlign: 'right' }]}>
              {row.line_count.toLocaleString('en-US')}
            </Text>
            <Text style={[styles.tableCell, { flex: 1, textAlign: 'right' }]}>
              {formatCents(row.monthly_total_cents)}
            </Text>
            <Text style={[styles.tableCellMuted, { flex: 1, textAlign: 'right' }]}>
              {Math.round(row.share * 100)}%
            </Text>
          </View>
        ))}
      </View>
      <PageFooter reportId="executive" generatedAt={generatedOn} />
    </Page>
  );
}

// ── 6. By category page (bar chart via <Rect>) ───────────────────────
function CategoryPage({
  rows,
  generatedOn,
}: {
  rows: ExecutiveCategoryRow[];
  generatedOn: string;
}): ReactElement {
  // Horizontal stacked bars — one per category. We only chart positive
  // savings; categories without savings still appear in the table.
  const max = rows.reduce(
    (m, r) => (r.estimated_monthly_savings_cents > m ? r.estimated_monthly_savings_cents : m),
    0,
  );
  const chartWidth = 460;
  const barHeight = 12;
  const rowHeight = 22;
  const chartHeight = Math.max(rowHeight, rows.length * rowHeight);

  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.sectionTitle}>Findings by category</Text>
      <Text style={styles.sectionSubtitle}>
        Estimated monthly savings rolled up across rule families.
      </Text>
      {rows.length === 0 ? (
        <Text style={styles.tableCellMuted}>No findings to categorize.</Text>
      ) : (
        <>
          <View style={styles.barGroup}>
            {rows.map((row) => {
              const pct = max > 0 ? row.estimated_monthly_savings_cents / max : 0;
              const w = Math.max(1, Math.round(pct * chartWidth));
              return (
                <View key={row.category_label} style={{ marginBottom: 10 }}>
                  <View style={styles.barLabelRow}>
                    <Text style={styles.barLabel}>
                      {row.category_label} · {row.finding_count.toLocaleString('en-US')} finding
                      {row.finding_count === 1 ? '' : 's'}
                    </Text>
                    <Text style={styles.barValue}>
                      {formatCents(row.estimated_monthly_savings_cents)}/mo
                    </Text>
                  </View>
                  <Svg width={chartWidth} height={barHeight}>
                    <Rect x={0} y={0} width={chartWidth} height={barHeight} fill={COLORS.card} />
                    <Rect x={0} y={0} width={w} height={barHeight} fill={COLORS.bar} />
                  </Svg>
                </View>
              );
            })}
          </View>
          {/* Sentinel to keep the chartHeight reference in scope for
              future tweaks without a lint warning. */}
          <View style={{ height: 0, width: chartHeight }} />
        </>
      )}
      <PageFooter reportId="executive" generatedAt={generatedOn} />
    </Page>
  );
}

// ── 7. Footer page ───────────────────────────────────────────────────
function FooterPage({ generatedOn }: { generatedOn: string }): ReactElement {
  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.sectionTitle}>About this report</Text>
      <Text style={styles.sectionSubtitle}>How to use this executive summary.</Text>

      <Text style={styles.groupHeading}>What&apos;s in here</Text>
      <Text style={[styles.tableCell, { marginBottom: 10 }]}>
        This document rolls up the findings, totals, and bill-change drivers from the most recent
        CarrierAudit audits. Per-line detail and PII — phone numbers, names, employee IDs — never
        leave the per-audit report. This summary is safe to share with finance leadership.
      </Text>

      <Text style={styles.groupHeading}>Savings estimates</Text>
      <Text style={[styles.tableCell, { marginBottom: 10 }]}>
        Estimated monthly savings come directly from the per-audit findings. Annual figures are 12×
        monthly. Savings are estimates that assume recommended actions are taken and underlying
        rates remain stable.
      </Text>

      <View style={styles.hr} />
      <Text style={styles.coverFootnote}>Generated {generatedOn} · Generated by CarrierAudit</Text>

      <PageFooter reportId="executive" generatedAt={generatedOn} />
    </Page>
  );
}

// ── Document ─────────────────────────────────────────────────────────
function ExecutiveDocument({
  data,
  generatedOn,
}: {
  data: ExecutiveReportData;
  generatedOn: string;
}): ReactElement {
  return (
    <Document
      title="CarrierAudit Executive Summary"
      author="CarrierAudit"
      subject="Wireless billing audit — multi-period executive summary"
      creator="CarrierAudit"
      producer="CarrierAudit"
    >
      <CoverPage data={data} generatedOn={generatedOn} />
      <TrendPage data={data} generatedOn={generatedOn} />
      <TopFindingsPage data={data} generatedOn={generatedOn} />
      {data.topAutopsyDrivers.length > 0 ? (
        <TopDriversPage drivers={data.topAutopsyDrivers} generatedOn={generatedOn} />
      ) : null}
      {data.byCostCenter && data.byCostCenter.length > 0 ? (
        <CostCenterPage rows={data.byCostCenter} generatedOn={generatedOn} />
      ) : null}
      <CategoryPage rows={data.byCategory} generatedOn={generatedOn} />
      <FooterPage generatedOn={generatedOn} />
    </Document>
  );
}

export interface RenderExecutiveOptions {
  /**
   * Display-only "Generated on" timestamp; injected by the route handler
   * so tests can pin it. Determinism: never call `new Date()` here.
   */
  generatedOn: string;
}

/**
 * Render the executive PDF to a Buffer. Server-only (depends on
 * @react-pdf/renderer's Node-only entry point).
 */
export async function renderExecutivePdf(
  data: ExecutiveReportData,
  options: RenderExecutiveOptions,
): Promise<Buffer> {
  return renderToBuffer(<ExecutiveDocument data={data} generatedOn={options.generatedOn} />);
}
