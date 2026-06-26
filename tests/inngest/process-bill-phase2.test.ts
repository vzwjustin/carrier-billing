import { describe, expect, it } from 'vitest';

import { processBillFn, __testables, translateLineIndexes } from '@/inngest/functions/process-bill';
import { functions } from '@/inngest/functions';
import type { ExtractedBill } from '@/extraction/schema';
import type { Finding } from '@/rules/types';

/**
 * Phase 2 structural smoke tests for the process-bill function.
 *
 * We deliberately don't try to invoke the Inngest function or run the rules
 * engine here — that requires a fully-wired Inngest test harness plus mocked
 * Anthropic + Supabase. Those live in the integration suite. These tests just
 * pin the public surface so a refactor doesn't accidentally break wiring.
 */
describe('processBillFn (phase 2)', () => {
  it('still has id "process-bill"', () => {
    const id = processBillFn.id();
    expect(id).toContain('process-bill');
  });

  it('is still exported from the functions registry', () => {
    expect(functions).toContain(processBillFn);
  });

  it('exposes a stable name', () => {
    expect(typeof processBillFn.name).toBe('string');
    expect(processBillFn.name.length).toBeGreaterThan(0);
  });

  it('exposes the testable internals', () => {
    expect(typeof __testables.translateLineIndexes).toBe('function');
    expect(typeof __testables.deriveFailureReason).toBe('function');
    expect(typeof __testables.withTimeout).toBe('function');
    expect(typeof __testables.EXTRACTION_TIMEOUT_MS).toBe('number');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (B1) End-to-end-ish: the 2-account fixture proves the rule-emitted finding
// on account 1, line 1 of a [5,3] bill resolves to the 7th flat line UUID,
// not the 2nd. We do this without booting the Inngest harness by feeding
// the translated finding list through the same flat-id lookup pattern that
// `persistFindings` uses internally.
// ───────────────────────────────────────────────────────────────────────────

describe('B1 — multi-account finding-to-UUID mapping', () => {
  it('finding raised on account 1, line 1 of a [5,3] bill stamps the correct UUID', () => {
    // Build a [5, 3] bill — same shape the bug report describes.
    const bill: ExtractedBill = {
      carrier: 'verizon',
      billing_period_start: '2026-04-01',
      billing_period_end: '2026-04-30',
      total_charges_cents: 0,
      notes: [],
      accounts: [5, 3].map((n, ai) => ({
        account_number_last4: '0000',
        label: `acct-${ai}`,
        total_charges_cents: 0,
        taxes_fees_cents: 0,
        account_level_credits: [],
        lines: Array.from({ length: n }, (_v, li) => ({
          mdn_last4: '0000',
          user_label: `acct${ai}-line${li}`,
          device: null,
          plan_name: null,
          plan_base_cents: null,
          data_used_gb: null,
          voice_used_min: null,
          sms_used_count: null,
          is_suspended: false,
          features: [],
          credits: [],
          dpp_installments: [],
        })),
      })),
    };

    // Simulate the persist-bill output: account-major, generated UUIDs in order.
    // Account 0 owns lineIds 0..4 (uuid-a-l0…uuid-a-l4); account 1 owns lineIds 5..7
    // (uuid-b-l0…uuid-b-l2). The "wanted" UUID for account 1, line 1 is uuid-b-l1.
    const lineIds: string[][] = [
      ['uuid-a-l0', 'uuid-a-l1', 'uuid-a-l2', 'uuid-a-l3', 'uuid-a-l4'],
      ['uuid-b-l0', 'uuid-b-l1', 'uuid-b-l2'],
    ];
    const accountIds: string[] = ['uuid-acct-0', 'uuid-acct-1'];

    // Rule emits per-account-local: lineIndex=1 with accountIndex=1.
    const ruleOutput: Finding[] = [
      {
        rule_id: 'orphan_insurance',
        severity: 'high',
        title: 't',
        description: 'd',
        recommended_action: 'a',
        estimated_monthly_savings_cents: 1500,
        confidence: 0.85,
        affected_account_indexes: [1],
        affected_line_indexes: [1], // per-account local
        evidence: {},
      },
    ];

    // Run the same pipeline process-bill runs:
    // 1) translate per-account → global flat indexes
    // 2) resolve via persistFindings's flat-line-id lookup
    const translated = translateLineIndexes(ruleOutput, bill, {
      auditId: 'audit-1',
      warn: () => undefined,
    });

    // Mirror persistFindings's flatLineIds construction and resolution.
    const flatLineIds: string[] = [];
    for (const bucket of lineIds) {
      for (const id of bucket) flatLineIds.push(id);
    }
    const finding = translated[0];
    expect(finding).toBeDefined();
    const resolvedLineUuids = (finding?.affected_line_indexes ?? [])
      .map((i) => flatLineIds[i])
      .filter((v): v is string => typeof v === 'string');
    const resolvedAccountUuids = (finding?.affected_account_indexes ?? [])
      .map((i) => accountIds[i])
      .filter((v): v is string => typeof v === 'string');

    // The finding lands on the SECOND account's SECOND line — not the first.
    expect(resolvedLineUuids).toEqual(['uuid-b-l1']);
    expect(resolvedAccountUuids).toEqual(['uuid-acct-1']);
    // Sanity: it is NOT uuid-a-l1 (which is what the pre-fix flat lookup
    // would have returned for the rule's raw localIdx=1).
    expect(resolvedLineUuids[0]).not.toBe('uuid-a-l1');
  });
});
