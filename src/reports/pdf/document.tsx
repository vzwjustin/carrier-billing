/**
 * CarrierAudit report — @react-pdf/renderer Document.
 *
 * No PII: this component is fed `ReportData` whose Finding rows already
 * exclude phone numbers, employee names, and full account numbers. Only
 * masked last-4 values reach the page.
 *
 * Layout:
 *   1. Cover page
 *   2. Executive summary page
 *   3. Findings pages (high → medium → low → info)
 *   4. Methodology + disclaimer page
 */
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { ReactElement } from 'react';

import { formatCents } from '@/lib/utils';
import { FindingCard } from '@/reports/pdf/finding-card';
import type { ReportData, Finding, Severity } from '@/reports/types';

// -- Styles ----------------------------------------------------------------

const COLORS = {
  ink: '#0F172A',
  muted: '#64748B',
  subtle: '#94A3B8',
  border: '#E2E8F0',
  page: '#FFFFFF',
  card: '#F8FAFC',
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
  // -- Cover --------------------------------------------------------------
  coverWrap: {
    flex: 1,
    justifyContent: 'space-between',
  },
  coverTopBlock: {
    marginTop: 80,
  },
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
  coverSubtitle: {
    fontSize: 14,
    color: COLORS.muted,
    marginTop: 12,
  },
  coverMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 36,
  },
  coverMetaItem: {
    width: '50%',
    marginBottom: 16,
  },
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
  coverFootnote: {
    fontSize: 9,
    color: COLORS.subtle,
  },
  // -- Headings -----------------------------------------------------------
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    marginBottom: 4,
  },
  sectionSubtitle: {
    fontSize: 10,
    color: COLORS.muted,
    marginBottom: 20,
  },
  groupHeading: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    marginTop: 16,
    marginBottom: 8,
  },
  // -- Summary stat cards -------------------------------------------------
  statRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -6,
    marginBottom: 12,
  },
  statCol: {
    paddingHorizontal: 6,
    marginBottom: 12,
  },
  statColHalf: { width: '50%' },
  statColThird: { width: '33.3333%' },
  statCard: {
    backgroundColor: COLORS.card,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14,
  },
  statLabel: {
    fontSize: 8,
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
  },
  statValueXL: {
    fontSize: 28,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  statValueLG: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  statValueMD: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  statHelp: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 4,
  },
  // -- Account cards (executive-summary breakdown) ------------------------
  findingCardSmall: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    padding: 10,
    marginBottom: 8,
  },
  findingHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  findingHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingRight: 8,
  },
  findingTitleSmall: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    flex: 1,
  },
  savingsSmall: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: '#047857',
    textAlign: 'right',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  chip: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginRight: 6,
  },
  chipText: {
    fontSize: 8,
    color: COLORS.muted,
  },
  // -- Methodology --------------------------------------------------------
  paragraph: {
    fontSize: 10,
    color: COLORS.ink,
    marginBottom: 10,
  },
  small: {
    fontSize: 9,
    color: COLORS.muted,
  },
  // -- Page footer --------------------------------------------------------
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
  hr: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 12,
  },
});

// -- Helpers ---------------------------------------------------------------

const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low', 'info'];

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

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return '—';
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function pluralize(n: number, singular: string, plural?: string): string {
  if (n === 1) return `${n} ${singular}`;
  return `${n} ${plural ?? `${singular}s`}`;
}

// -- Components ------------------------------------------------------------

function PageFooter({ auditId }: { auditId: string }): ReactElement {
  return (
    <View style={styles.footer} fixed>
      <Text>CarrierAudit · {auditId.slice(0, 8)}</Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          `Page ${pageNumber} of ${totalPages}`
        }
      />
    </View>
  );
}

function CoverPage({ report }: { report: ReportData }): ReactElement {
  const generatedOn = report.audit.completed_at
    ? formatDate(report.audit.completed_at)
    : formatDate(new Date().toISOString());

  return (
    <Page size="A4" style={styles.page}>
      <View style={styles.coverWrap}>
        <View style={styles.coverTopBlock}>
          <Text style={styles.coverEyebrow}>CarrierAudit</Text>
          <Text style={styles.coverTitle}>CarrierAudit Report</Text>
          <Text style={styles.coverSubtitle}>
            Wireless billing audit — quantified savings &amp; recommended actions
          </Text>

          <View style={styles.coverMetaRow}>
            <View style={styles.coverMetaItem}>
              <Text style={styles.coverMetaLabel}>Audit ID</Text>
              <Text style={styles.coverMetaValue}>{report.audit.id}</Text>
            </View>
            <View style={styles.coverMetaItem}>
              <Text style={styles.coverMetaLabel}>Carrier</Text>
              <Text style={styles.coverMetaValue}>
                {carrierName(report.audit.carrier)}
              </Text>
            </View>
            <View style={styles.coverMetaItem}>
              <Text style={styles.coverMetaLabel}>Billing period</Text>
              <Text style={styles.coverMetaValue}>
                {formatPeriod(
                  report.audit.billing_period_start,
                  report.audit.billing_period_end,
                )}
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
            Confidential — prepared for the bill owner. Not affiliated with
            Verizon, AT&amp;T, or T-Mobile.
          </Text>
        </View>
      </View>
      <PageFooter auditId={report.audit.id} />
    </Page>
  );
}

function ExecutiveSummaryPage({
  report,
}: {
  report: ReportData;
}): ReactElement {
  const { audit } = report;
  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.sectionTitle}>Executive summary</Text>
      <Text style={styles.sectionSubtitle}>
        At-a-glance view of the savings opportunity uncovered by this audit.
      </Text>

      {/* Hero savings row */}
      <View style={styles.statRow}>
        <View style={[styles.statCol, styles.statColHalf]}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Estimated monthly savings</Text>
            <Text style={styles.statValueXL}>
              {formatCents(audit.estimated_monthly_savings_cents)}
            </Text>
            <Text style={styles.statHelp}>
              Across {pluralize(audit.finding_count, 'finding')}
            </Text>
          </View>
        </View>
        <View style={[styles.statCol, styles.statColHalf]}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Estimated annual savings</Text>
            <Text style={styles.statValueXL}>
              {formatCents(audit.estimated_annual_savings_cents)}
            </Text>
            <Text style={styles.statHelp}>
              Assumes recommended actions taken
            </Text>
          </View>
        </View>
      </View>

      {/* Counts row */}
      <View style={styles.statRow}>
        <View style={[styles.statCol, styles.statColThird]}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Findings</Text>
            <Text style={styles.statValueLG}>{audit.finding_count}</Text>
          </View>
        </View>
        <View style={[styles.statCol, styles.statColThird]}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>High severity</Text>
            <Text style={styles.statValueLG}>{audit.high_severity_count}</Text>
          </View>
        </View>
        <View style={[styles.statCol, styles.statColThird]}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Total bill charges</Text>
            <Text style={styles.statValueLG}>
              {formatCents(audit.total_charges_cents ?? 0)}
            </Text>
          </View>
        </View>
      </View>

      {/* Bill summary row */}
      <View style={styles.statRow}>
        <View style={[styles.statCol, styles.statColHalf]}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Accounts</Text>
            <Text style={styles.statValueMD}>{audit.account_count}</Text>
          </View>
        </View>
        <View style={[styles.statCol, styles.statColHalf]}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Lines</Text>
            <Text style={styles.statValueMD}>{audit.line_count}</Text>
          </View>
        </View>
      </View>

      {/* Bill accounts breakdown */}
      {report.bill.accounts.length > 0 ? (
        <>
          <View style={styles.hr} />
          <Text style={styles.groupHeading}>Accounts</Text>
          {report.bill.accounts.map((acc) => (
            <View key={acc.id} style={styles.findingCardSmall}>
              <View style={styles.findingHeaderRow}>
                <View style={styles.findingHeaderLeft}>
                  <Text style={styles.findingTitleSmall}>
                    {acc.label ?? 'Account'}
                    {acc.account_number_masked
                      ? ` · …${acc.account_number_masked}`
                      : ''}
                  </Text>
                </View>
                <Text style={styles.savingsSmall}>
                  {formatCents(acc.total_charges_cents ?? 0)}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <View style={styles.chip}>
                  <Text style={styles.chipText}>
                    {pluralize(acc.lineCount, 'line')}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </>
      ) : null}

      <PageFooter auditId={audit.id} />
    </Page>
  );
}

function FindingsSection({
  severity,
  findings,
  auditId,
}: {
  severity: Severity;
  findings: Finding[];
  auditId: string;
}): ReactElement | null {
  if (findings.length === 0) return null;

  const small = severity === 'low' || severity === 'info';
  const heading: Record<Severity, string> = {
    high: 'High-severity findings',
    medium: 'Medium-severity findings',
    low: 'Low-severity findings',
    info: 'Informational findings',
  };
  const subhead: Record<Severity, string> = {
    high: 'Address these first — biggest dollars on the table.',
    medium: 'Worth tackling once the high-severity items are resolved.',
    low: 'Smaller dollars or lower confidence — review when convenient.',
    info: 'Context only; no recommended action.',
  };

  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.sectionTitle}>{heading[severity]}</Text>
      <Text style={styles.sectionSubtitle}>{subhead[severity]}</Text>
      {findings.map((f, idx) => (
        <FindingCard key={`${f.rule_id}-${idx}`} finding={f} small={small} />
      ))}
      <PageFooter auditId={auditId} />
    </Page>
  );
}

function MethodologyPage({ auditId }: { auditId: string }): ReactElement {
  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.sectionTitle}>Methodology &amp; disclaimer</Text>
      <Text style={styles.sectionSubtitle}>
        How this report was produced and what its limitations are.
      </Text>

      <Text style={styles.groupHeading}>How we audit</Text>
      <Text style={styles.paragraph}>
        CarrierAudit reads the uploaded business wireless bill, normalizes the
        charges into a structured representation of accounts, lines, plans,
        features, credits, and device-payment installments, and then applies
        a curated rule set built from years of telecom-billing audit
        experience. Each rule independently inspects the bill for a known
        waste pattern — such as expired promotional credits, completed device
        payments still being billed, orphaned insurance on suspended lines, or
        unused features — and surfaces a finding when its conditions are met.
        Findings are ranked by severity (high, medium, low, info) and sorted
        within each tier by their estimated monthly savings.
      </Text>

      <Text style={styles.groupHeading}>Estimated savings</Text>
      <Text style={styles.paragraph}>
        Every finding includes an estimated monthly savings figure derived
        directly from the line items on your bill. The annual savings figure
        on the executive summary is twelve times the monthly total. Savings
        are estimates, not guarantees, and assume no offsetting changes to
        your plan, taxes, or surcharges.
      </Text>

      <Text style={styles.groupHeading}>Disclaimer</Text>
      <Text style={styles.paragraph}>
        This report is informational only. Savings estimates assume the
        recommended action is taken successfully and rates remain stable.
        Verify all recommendations with your carrier representative before
        acting. CarrierAudit is not affiliated with Verizon, AT&amp;T, or
        T-Mobile, and the use of those names is solely to identify the
        carrier of the audited bill.
      </Text>

      <View style={styles.hr} />
      <Text style={styles.small}>
        Report ID {auditId} · Generated by CarrierAudit
      </Text>

      <PageFooter auditId={auditId} />
    </Page>
  );
}

// -- Public document --------------------------------------------------------

export function ReportDocument({
  report,
}: {
  report: ReportData;
}): ReactElement {
  return (
    <Document
      title={`CarrierAudit Report ${report.audit.id.slice(0, 8)}`}
      author="CarrierAudit"
      subject="Wireless billing audit"
      creator="CarrierAudit"
      producer="CarrierAudit"
    >
      <CoverPage report={report} />
      <ExecutiveSummaryPage report={report} />
      {SEVERITY_ORDER.map((sev) => (
        <FindingsSection
          key={sev}
          severity={sev}
          findings={report.findingsBySeverity[sev]}
          auditId={report.audit.id}
        />
      ))}
      <MethodologyPage auditId={report.audit.id} />
    </Document>
  );
}
