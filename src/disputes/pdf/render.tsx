/**
 * Server-only @react-pdf/renderer entry point for the dispute packet PDF.
 *
 * Imported lazily from the route to keep @react-pdf/renderer out of the
 * route's cold path until a dispute PDF is actually requested. Mirrors
 * `src/reports/pdf/render.tsx`.
 */
import 'server-only';

import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { ReactElement } from 'react';

import type { DisputePacket } from '@/disputes/builder';

// -- Styles ----------------------------------------------------------------

const COLORS = {
  ink: '#0F172A',
  muted: '#64748B',
  subtle: '#94A3B8',
  border: '#E2E8F0',
  page: '#FFFFFF',
  card: '#F8FAFC',
  accent: '#0F172A',
} as const;

const SEVERITY: Record<DisputePacket['severity'], { bg: string; text: string }> = {
  high: { bg: '#FECACA', text: '#B91C1C' },
  medium: { bg: '#FED7AA', text: '#B45309' },
  low: { bg: '#BFDBFE', text: '#1D4ED8' },
  info: { bg: '#E5E5E5', text: '#525252' },
};

const styles = StyleSheet.create({
  page: {
    backgroundColor: COLORS.page,
    color: COLORS.ink,
    fontFamily: 'Helvetica',
    fontSize: 10,
    paddingTop: 40,
    paddingBottom: 48,
    paddingHorizontal: 42,
    lineHeight: 1.4,
  },
  eyebrow: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 2,
    color: COLORS.muted,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  title: {
    fontSize: 22,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    marginBottom: 14,
  },
  metaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -6,
    marginBottom: 14,
  },
  metaCell: {
    width: '50%',
    paddingHorizontal: 6,
    marginBottom: 8,
  },
  metaLabel: {
    fontSize: 8,
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 2,
  },
  metaValue: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  sectionHeading: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    marginTop: 12,
    marginBottom: 6,
  },
  paragraph: {
    fontSize: 10,
    color: COLORS.ink,
    marginBottom: 8,
  },
  recommendBlock: {
    backgroundColor: COLORS.card,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.accent,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 10,
  },
  recommendLabel: {
    fontSize: 8,
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 2,
  },
  recommendText: {
    fontSize: 10,
    color: COLORS.ink,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    marginRight: 8,
  },
  badgeText: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  chip: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginRight: 6,
    marginBottom: 4,
  },
  chipText: {
    fontSize: 8,
    color: COLORS.muted,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginBottom: 12,
  },
  // -- Affected lines table -------------------------------------------------
  table: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 4,
    marginBottom: 12,
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  tableRow: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  tableRowLast: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  tableCellHeading: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  tableCell: {
    fontSize: 10,
    color: COLORS.ink,
  },
  colMdn: {
    width: '30%',
  },
  colPlan: {
    width: '70%',
  },
  emptyTableNote: {
    fontSize: 9,
    color: COLORS.muted,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  // -- Phone script ---------------------------------------------------------
  phoneBlock: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 4,
    padding: 10,
    marginBottom: 8,
  },
  phoneBullet: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  phoneDot: {
    fontSize: 10,
    color: COLORS.muted,
    width: 10,
  },
  phoneText: {
    fontSize: 10,
    color: COLORS.ink,
    flex: 1,
  },
  // -- Footer ---------------------------------------------------------------
  footer: {
    position: 'absolute',
    left: 42,
    right: 42,
    bottom: 24,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: COLORS.subtle,
  },
});

// -- Components ------------------------------------------------------------

function SeverityBadge({ packet }: { packet: DisputePacket }): ReactElement {
  const palette = SEVERITY[packet.severity];
  return (
    <View style={[styles.badge, { backgroundColor: palette.bg }]}>
      <Text style={[styles.badgeText, { color: palette.text }]}>{packet.severityLabel}</Text>
    </View>
  );
}

function MetaCell({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <View style={styles.metaCell}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function AffectedLinesTable({ packet }: { packet: DisputePacket }): ReactElement {
  if (packet.affectedLines.length === 0) {
    return (
      <View style={styles.table}>
        <Text style={styles.emptyTableNote}>
          No specific lines identified — applies to the account.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.table}>
      <View style={styles.tableHeaderRow}>
        <Text style={[styles.tableCellHeading, styles.colMdn]}>Line</Text>
        <Text style={[styles.tableCellHeading, styles.colPlan]}>Plan</Text>
      </View>
      {packet.affectedLines.map((row, idx) => {
        const isLast = idx === packet.affectedLines.length - 1;
        return (
          <View
            key={`${row.mdnDisplay}-${idx}`}
            style={isLast ? styles.tableRowLast : styles.tableRow}
          >
            <Text style={[styles.tableCell, styles.colMdn]}>{row.mdnDisplay}</Text>
            <Text style={[styles.tableCell, styles.colPlan]}>{row.planDisplay}</Text>
          </View>
        );
      })}
    </View>
  );
}

function PhoneScriptBlock({ packet }: { packet: DisputePacket }): ReactElement {
  return (
    <View style={styles.phoneBlock}>
      {packet.phoneScript.map((line, idx) => (
        <View key={idx} style={styles.phoneBullet}>
          <Text style={styles.phoneDot}>•</Text>
          <Text style={styles.phoneText}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

function PageFooter({ packet }: { packet: DisputePacket }): ReactElement {
  return (
    <View style={styles.footer} fixed>
      <Text>Generated by CarrierAudit · {packet.generatedDateDisplay}</Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

function DisputeDocument({ packet }: { packet: DisputePacket }): ReactElement {
  return (
    <Document
      title={`CarrierAudit Dispute Packet ${packet.auditShortId}`}
      author="CarrierAudit"
      subject="Carrier billing dispute"
      creator="CarrierAudit"
      producer="CarrierAudit"
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.eyebrow}>CarrierAudit</Text>
        <Text style={styles.title}>Carrier Billing Dispute Packet</Text>

        <View style={styles.badgeRow}>
          <SeverityBadge packet={packet} />
          <View style={styles.chip}>
            <Text style={styles.chipText}>{packet.ruleId}</Text>
          </View>
          <View style={styles.chip}>
            <Text style={styles.chipText}>Confidence {packet.confidencePercent}%</Text>
          </View>
        </View>

        <View style={styles.metaGrid}>
          <MetaCell label="Carrier" value={packet.carrierName} />
          <MetaCell label="Billing period" value={packet.billingPeriodDisplay} />
          <MetaCell
            label="Account(s)"
            value={
              packet.accounts.length === 0
                ? '—'
                : packet.accounts
                    .map((a) => (a.label ? `${a.label} · ${a.numberDisplay}` : a.numberDisplay))
                    .join('  ·  ')
            }
          />
          <MetaCell label="Finding" value={packet.findingTitle} />
          <MetaCell label="Requested credit" value={packet.requestedCreditDisplay} />
          <MetaCell label="Severity" value={packet.severityLabel} />
        </View>

        <Text style={styles.sectionHeading}>What we found</Text>
        <Text style={styles.paragraph}>{packet.description}</Text>

        <View style={styles.recommendBlock}>
          <Text style={styles.recommendLabel}>Recommended action</Text>
          <Text style={styles.recommendText}>{packet.recommendedAction}</Text>
        </View>

        <Text style={styles.sectionHeading}>Affected lines</Text>
        <AffectedLinesTable packet={packet} />

        <Text style={styles.sectionHeading}>Phone script</Text>
        <PhoneScriptBlock packet={packet} />

        <PageFooter packet={packet} />
      </Page>
    </Document>
  );
}

export async function renderDisputePdf(packet: DisputePacket): Promise<Buffer> {
  return renderToBuffer(<DisputeDocument packet={packet} />);
}
