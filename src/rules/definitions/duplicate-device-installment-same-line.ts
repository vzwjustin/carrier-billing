import type { Rule, Finding } from '../types';
import { formatCents } from '../helpers';

const RULE_ID = 'duplicate_device_installment_same_line';

/**
 * A line carrying 2+ device payment plan installments where two installments
 * share the same `device` string. Strong smell of a billing double-add — the
 * carrier mistakenly attached two financing rows for the same device, or
 * failed to close the prior installment when a device was returned/replaced
 * during the cycle.
 *
 * High-severity / high-confidence: a same-device DPP duplication is a
 * concrete billing artifact that's almost always resolved with a credit
 * once raised with the carrier. Conservative posture on `confidence`
 * (0.8 — top of the "Likely" bucket): the one legitimate edge is a device
 * trade-in mid-cycle where both old- and new-device installments briefly
 * coexist on the same line, which the carrier can confirm.
 */
export const duplicateDeviceInstallmentSameLineRule: Rule = {
  id: RULE_ID,
  title: 'Two device-payment-plan rows for the same device on one line',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        if (line.dpp_installments.length < 2) return;

        // Group DPP rows by device name (case-insensitive, trimmed). Any
        // group with size ≥ 2 is the smoking gun.
        const byDevice = new Map<string, typeof line.dpp_installments>();
        for (const dpp of line.dpp_installments) {
          const key = dpp.device.trim().toLowerCase();
          const bucket = byDevice.get(key) ?? [];
          bucket.push(dpp);
          byDevice.set(key, bucket);
        }

        // ⚡ Bolt: Single-pass iteration avoids intermediate Array allocation from Array.from()
        const duplicates: Array<[string, typeof line.dpp_installments]> = [];
        for (const entry of byDevice.entries()) {
          if (entry[1].length >= 2) {
            duplicates.push(entry);
          }
        }

        if (duplicates.length === 0) return;

        // Recoverable amount = sum of the duplicated installments minus one
        // copy per group (the "real" installment we'd expect to keep).
        let recoverable = 0;
        const groupSummaries: Array<{
          device: string;
          count: number;
          monthly_cents_each: number[];
        }> = [];
        for (const [, rows] of duplicates) {
          // Sort by monthly_cents descending; treat the smallest as the
          // "legitimate" one and assume the larger duplicate(s) are the
          // erroneous add(s). Conservative when amounts differ.
          const sorted = [...rows].sort((a, b) => b.monthly_cents - a.monthly_cents);
          for (let i = 0; i < sorted.length - 1; i += 1) {
            recoverable += sorted[i]?.monthly_cents ?? 0;
          }
          // Use the first row's device for the human-readable name (already
          // case-normalized into the bucket key, but display the original).
          const firstRow = rows[0];
          if (firstRow !== undefined) {
            groupSummaries.push({
              device: firstRow.device,
              count: rows.length,
              monthly_cents_each: rows.map((r) => r.monthly_cents),
            });
          }
        }

        if (recoverable <= 0) return;
        const deviceList = groupSummaries.map((g) => `"${g.device}"`).join(', ');

        findings.push({
          rule_id: RULE_ID,
          severity: 'high',
          title: `Duplicate device installments on one line (${deviceList})`,
          description: `This line has ${line.dpp_installments.length} device-payment-plan rows, and at least one device name is duplicated (${deviceList}). The most common cause is the carrier failing to close out a prior installment when a device was traded/upgraded, leaving both rows billing in parallel. Recoverable monthly amount estimated at ${formatCents(recoverable)} per cycle.`,
          recommended_action:
            'Dispute the duplicate installment row(s) with the carrier and request a credit for any cycles already billed. Ask the rep to confirm only the correct (current) financing agreement remains active on the line.',
          estimated_monthly_savings_cents: recoverable,
          // Top of "Likely" bucket per types.ts. The structural signal is
          // very strong but doesn't rule out a brief mid-cycle trade-in
          // overlap, which is the one legitimate edge.
          confidence: 0.8,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            dpp_count: line.dpp_installments.length,
            duplicate_groups: groupSummaries,
            recoverable_monthly_cents: recoverable,
          },
        });
      });
    });

    return findings;
  },
};
