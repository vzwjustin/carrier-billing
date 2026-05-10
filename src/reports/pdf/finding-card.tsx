/**
 * @react-pdf/renderer FindingCard. Consumes the shared `FindingViewModel`
 * so the field set stays in lockstep with the web FindingCard.
 *
 * Visual decisions (chip layout, font size, "small" variant) are
 * surface-specific and stay here. Data shaping lives in
 * `src/reports/finding-view-model.ts`.
 */
import { Text, View, StyleSheet } from '@react-pdf/renderer';
import type { ReactElement } from 'react';

import { formatCents } from '@/lib/utils';
import type { Finding, Severity } from '@/rules/types';
import {
  buildFindingViewModel,
  type FindingViewModel,
} from '@/reports/finding-view-model';

const COLORS = {
  ink: '#0F172A',
  muted: '#64748B',
  border: '#E2E8F0',
  card: '#F8FAFC',
  accent: '#0F172A',
} as const;

const SEVERITY: Record<Severity, { bg: string; text: string }> = {
  high: { bg: '#FECACA', text: '#B91C1C' },
  medium: { bg: '#FED7AA', text: '#B45309' },
  low: { bg: '#BFDBFE', text: '#1D4ED8' },
  info: { bg: '#E5E5E5', text: '#525252' },
};

const styles = StyleSheet.create({
  findingCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    padding: 14,
    marginBottom: 10,
  },
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
  findingTitle: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    flex: 1,
  },
  findingTitleSmall: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    flex: 1,
  },
  savings: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: '#047857',
    textAlign: 'right',
  },
  savingsSmall: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: '#047857',
    textAlign: 'right',
  },
  findingBody: {
    fontSize: 10,
    color: COLORS.ink,
    marginBottom: 6,
  },
  findingBodySmall: {
    fontSize: 9,
    color: COLORS.ink,
    marginBottom: 4,
  },
  recommendBlock: {
    backgroundColor: COLORS.card,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.accent,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 6,
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
  recommendTextSmall: {
    fontSize: 9,
    color: COLORS.ink,
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
});

function pluralize(n: number, singular: string, plural?: string): string {
  if (n === 1) return `${n} ${singular}`;
  return `${n} ${plural ?? `${singular}s`}`;
}

function SeverityBadge({
  severity,
  label,
}: {
  severity: Severity;
  label: string;
}): ReactElement {
  const palette = SEVERITY[severity];
  return (
    <View style={[styles.badge, { backgroundColor: palette.bg }]}>
      <Text style={[styles.badgeText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

export function FindingCard({
  finding,
  small = false,
}: {
  finding: Finding;
  small?: boolean;
}): ReactElement {
  const vm: FindingViewModel = buildFindingViewModel(finding);

  const cardStyle = small ? styles.findingCardSmall : styles.findingCard;
  const titleStyle = small ? styles.findingTitleSmall : styles.findingTitle;
  const bodyStyle = small ? styles.findingBodySmall : styles.findingBody;
  const recoStyle = small ? styles.recommendTextSmall : styles.recommendText;
  const savingsStyle = small ? styles.savingsSmall : styles.savings;

  return (
    // Outer card MUST be allowed to wrap across pages — long descriptions
    // get clipped when the whole card is forced onto a single page. We
    // only keep the header (severity badge + title + savings) together,
    // which is the part users skim.
    <View style={cardStyle}>
      <View style={styles.findingHeaderRow} wrap={false}>
        <View style={styles.findingHeaderLeft}>
          <SeverityBadge severity={vm.severity} label={vm.severityLabel} />
          <Text style={titleStyle}>{vm.title}</Text>
        </View>
        <Text style={savingsStyle}>
          {formatCents(vm.monthlySavingsCents)}/mo
        </Text>
      </View>

      <Text style={bodyStyle}>{vm.description}</Text>

      <View style={styles.recommendBlock}>
        <Text style={styles.recommendLabel}>Recommended action</Text>
        <Text style={recoStyle}>{vm.recommendedAction}</Text>
      </View>

      <View style={styles.metaRow}>
        {vm.affectedLineCount > 0 ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>
              {pluralize(vm.affectedLineCount, 'line')} affected
            </Text>
          </View>
        ) : null}
        {vm.affectedAccountCount > 0 ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>
              {pluralize(vm.affectedAccountCount, 'account')} affected
            </Text>
          </View>
        ) : null}
        <View style={styles.chip}>
          <Text style={styles.chipText}>
            Confidence {vm.confidencePercent}%
          </Text>
        </View>
        <View style={styles.chip}>
          <Text style={styles.chipText}>{vm.ruleId}</Text>
        </View>
      </View>
    </View>
  );
}
