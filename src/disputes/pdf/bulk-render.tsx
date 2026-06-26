/**
 * Server-only @react-pdf/renderer entry point for the bulk dispute letter
 * PDF. Imported lazily from the route so @react-pdf/renderer stays out of
 * the cold path until a letter is actually requested. Mirrors the pattern
 * in `src/disputes/pdf/render.tsx` and `src/reports/pdf/render.tsx`.
 *
 * The document is multi-page friendly: items render as a stack of `wrap`-
 * able blocks inside a single `<Page>`, so a long letter naturally flows
 * across pages without breaking inside an item header.
 */
import 'server-only';

import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { ReactElement } from 'react';

import type { BulkDisputeItemDisplay, BulkDisputeLetter } from '@/disputes/bulk-builder';

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

const SEVERITY: Record<BulkDisputeItemDisplay['severity'], { bg: string; text: string }> = {
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
  headerLine: {
    fontSize: 10,
    color: COLORS.ink,
    marginBottom: 4,
  },
  headerMuted: {
    fontSize: 9,
    color: COLORS.muted,
    marginBottom: 4,
  },
  intro: {
    fontSize: 10,
    color: COLORS.ink,
    marginTop: 12,
    marginBottom: 12,
  },
  totalBlock: {
    backgroundColor: COLORS.card,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.accent,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 14,
  },
  totalLabel: {
    fontSize: 8,
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 2,
  },
  totalValue: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
  },
  totalAnnual: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 2,
  },
  sectionHeading: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    marginTop: 8,
    marginBottom: 8,
  },
  itemBlock: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  itemHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  itemNumber: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.muted,
    width: 28,
  },
  itemTitle: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    flex: 1,
  },
  itemBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginBottom: 6,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    marginRight: 6,
    marginBottom: 2,
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
    marginBottom: 2,
  },
  chipText: {
    fontSize: 8,
    color: COLORS.muted,
  },
  itemParagraph: {
    fontSize: 10,
    color: COLORS.ink,
    marginBottom: 4,
  },
  itemMetaLabel: {
    fontSize: 8,
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
    marginBottom: 2,
  },
  itemMetaValue: {
    fontSize: 10,
    color: COLORS.ink,
    marginBottom: 2,
  },
  itemCreditValue: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    marginBottom: 2,
  },
  closing: {
    marginTop: 14,
  },
  closingLine: {
    fontSize: 10,
    color: COLORS.ink,
    marginBottom: 2,
  },
  closingNameLine: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    marginTop: 12,
    marginBottom: 2,
  },
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

function SeverityBadge({ item }: { item: BulkDisputeItemDisplay }): ReactElement {
  const palette = SEVERITY[item.severity];
  return (
    <View style={[styles.badge, { backgroundColor: palette.bg }]}>
      <Text style={[styles.badgeText, { color: palette.text }]}>{item.severityLabel}</Text>
    </View>
  );
}

function ItemBlock({ item }: { item: BulkDisputeItemDisplay }): ReactElement {
  return (
    <View style={styles.itemBlock} wrap={false}>
      <View style={styles.itemHeaderRow}>
        <Text style={styles.itemNumber}>{`${item.itemNumber}.`}</Text>
        <Text style={styles.itemTitle}>{item.title}</Text>
      </View>

      <View style={styles.itemBadgeRow}>
        <SeverityBadge item={item} />
        <View style={styles.chip}>
          <Text style={styles.chipText}>{item.ruleId}</Text>
        </View>
      </View>

      <Text style={styles.itemParagraph}>{item.description}</Text>

      <Text style={styles.itemMetaLabel}>Requested action</Text>
      <Text style={styles.itemParagraph}>{item.recommendedAction}</Text>

      <Text style={styles.itemMetaLabel}>Requested credit</Text>
      <Text style={styles.itemCreditValue}>{item.requestedCreditDisplay}</Text>

      <Text style={styles.itemMetaLabel}>Affected accounts</Text>
      <Text style={styles.itemMetaValue}>
        {item.affectedAccounts.length === 0 ? '—' : item.affectedAccounts.join('  ·  ')}
      </Text>

      <Text style={styles.itemMetaLabel}>Affected lines</Text>
      <Text style={styles.itemMetaValue}>
        {item.affectedMdns.length === 0 ? '—' : item.affectedMdns.join('  ·  ')}
      </Text>
    </View>
  );
}

function PageFooter({ letter }: { letter: BulkDisputeLetter }): ReactElement {
  return (
    <View style={styles.footer} fixed>
      <Text>
        {`Generated by CarrierAudit · ${letter.generatedDateDisplay} · Ref ${letter.auditShortId}`}
      </Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

function BulkDisputeDocument({ letter }: { letter: BulkDisputeLetter }): ReactElement {
  return (
    <Document
      title={`CarrierAudit Dispute Letter ${letter.auditShortId}`}
      author="CarrierAudit"
      subject={`Carrier billing dispute (${letter.carrierName})`}
      creator="CarrierAudit"
      producer="CarrierAudit"
    >
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.eyebrow}>CarrierAudit</Text>
        <Text style={styles.title}>Carrier Billing Dispute Letter</Text>

        <Text style={styles.headerLine}>{letter.generatedDateLong}</Text>
        <Text style={styles.headerLine}>{`To: ${letter.carrierName} Billing`}</Text>
        <Text style={styles.headerMuted}>
          {`Re: Billing period ${letter.billingPeriodDisplay} · Reference ${letter.auditShortId}`}
        </Text>

        <Text style={styles.intro}>
          {`I am writing to formally dispute the following items on my ${letter.carrierName} bill for the billing period ${letter.billingPeriodDisplay}. The items are itemized below; the total credit requested follows.`}
        </Text>

        <View style={styles.totalBlock} wrap={false}>
          <Text style={styles.totalLabel}>Total credit requested</Text>
          <Text style={styles.totalValue}>{letter.totalRequestedCreditDisplay}</Text>
          <Text style={styles.totalAnnual}>
            {`(approximately ${letter.totalRequestedCreditAnnualDisplay} over twelve months)`}
          </Text>
        </View>

        <Text style={styles.sectionHeading}>{`Disputed items (${letter.items.length})`}</Text>

        {letter.items.map((item) => (
          <ItemBlock key={`${item.itemNumber}-${item.ruleId}`} item={item} />
        ))}

        <View style={styles.closing} wrap={false}>
          {letter.closingBlock.map((line, idx) => {
            const isName = idx === letter.closingBlock.length - 1 && line.length > 0;
            return (
              <Text key={idx} style={isName ? styles.closingNameLine : styles.closingLine}>
                {line.length === 0 ? ' ' : line}
              </Text>
            );
          })}
        </View>

        <PageFooter letter={letter} />
      </Page>
    </Document>
  );
}

export async function renderBulkDisputePdf(letter: BulkDisputeLetter): Promise<Buffer> {
  return renderToBuffer(<BulkDisputeDocument letter={letter} />);
}
