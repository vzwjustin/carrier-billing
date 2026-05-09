import { describe, expect, it, vi } from 'vitest';

import { __testables } from '@/inngest/functions/process-bill';
import type { ExtractedBill } from '@/extraction/schema';
import type { Finding } from '@/rules/types';
import { ExtractionError } from '@/extraction/llm';
import { PipelineError } from '@/extraction/pipeline';

const {
  translateLineIndexes,
  deriveFailureReason,
  withTimeout,
  ExtractionTimeoutError,
  EXTRACTION_TIMEOUT_MS,
} = __testables;

// ───────────────────────────────────────────────────────────────────────────
// Helpers for building test fixtures
// ───────────────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    rule_id: 'test_rule',
    severity: 'medium',
    title: 't',
    description: 'd',
    recommended_action: 'a',
    estimated_monthly_savings_cents: 100,
    confidence: 1,
    affected_line_indexes: [],
    affected_account_indexes: [],
    evidence: {},
    ...overrides,
  };
}

/**
 * Build an ExtractedBill with the given per-account line counts. Carrier =
 * 'verizon' so it parses cleanly through the pipeline contract.
 */
function makeBill(linesPerAccount: number[]): ExtractedBill {
  return {
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: 0,
    notes: [],
    accounts: linesPerAccount.map((n, ai) => ({
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
}

const silentLogger = { warn: () => undefined };

// ───────────────────────────────────────────────────────────────────────────
// (B1) translateLineIndexes
// ───────────────────────────────────────────────────────────────────────────

describe('translateLineIndexes (B1)', () => {
  it('translates account 1, line 1 (per-account) to global index 6 in a [5,3] bill', () => {
    // Account 0 has 5 lines (global 0-4); account 1 has 3 lines (global 5-7).
    // Rule emits per-account-local: lineIndex=1 on accountIndex=1 → global 6.
    const bill = makeBill([5, 3]);
    const findings = [
      makeFinding({
        rule_id: 'orphan_insurance',
        affected_account_indexes: [1],
        affected_line_indexes: [1], // per-account local
      }),
    ];
    const out = translateLineIndexes(findings, bill, {
      auditId: 'a1',
      warn: silentLogger.warn,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.affected_line_indexes).toEqual([6]);
    expect(out[0]?.affected_account_indexes).toEqual([1]);
  });

  it('regression: WITHOUT translation, finding on acct 1 line 1 would have stamped acct 0 line 1', () => {
    // This is the exact bug-class B1 calls out: rule emits localIdx=1 with
    // accountIdx=1, and the OLD persistFindings logic treated localIdx=1 as
    // a global flat index — landing on the FIRST account's line 1 instead
    // of the SECOND account's line 1. Confirm translation produces the
    // correct global index, not the wrong one.
    const bill = makeBill([5, 3]);
    const findings = [
      makeFinding({
        affected_account_indexes: [1],
        affected_line_indexes: [1],
      }),
    ];
    const translated = translateLineIndexes(findings, bill, {
      auditId: 'a1',
      warn: silentLogger.warn,
    });
    const buggy = findings[0]?.affected_line_indexes[0]; // 1 — wrong global
    const fixed = translated[0]?.affected_line_indexes[0]; // 6 — right
    expect(buggy).toBe(1);
    expect(fixed).toBe(6);
    expect(fixed).not.toBe(buggy);
  });

  it('translates multiple per-account local indexes in one finding', () => {
    const bill = makeBill([2, 4]);
    const findings = [
      makeFinding({
        affected_account_indexes: [1],
        affected_line_indexes: [0, 2, 3], // locals on account 1
      }),
    ];
    const out = translateLineIndexes(findings, bill, {
      auditId: 'a1',
      warn: silentLogger.warn,
    });
    expect(out[0]?.affected_line_indexes).toEqual([2, 4, 5]);
  });

  it('preserves account-only findings (e.g. account_level_credit) unchanged', () => {
    const bill = makeBill([3, 3]);
    const findings = [
      makeFinding({
        rule_id: 'account_level_promo_about_to_expire',
        affected_account_indexes: [0],
        affected_line_indexes: [],
      }),
    ];
    const out = translateLineIndexes(findings, bill, {
      auditId: 'a1',
      warn: silentLogger.warn,
    });
    expect(out[0]?.affected_account_indexes).toEqual([0]);
    expect(out[0]?.affected_line_indexes).toEqual([]);
  });

  it('warns and drops line indexes when no account index is present', () => {
    const bill = makeBill([3, 3]);
    const findings = [
      makeFinding({
        affected_account_indexes: [],
        affected_line_indexes: [1],
      }),
    ];
    const warn = vi.fn();
    const out = translateLineIndexes(findings, bill, {
      auditId: 'a1',
      warn,
    });
    expect(out[0]?.affected_line_indexes).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('warns and drops line indexes when account index is out of range', () => {
    const bill = makeBill([2, 2]);
    const findings = [
      makeFinding({
        affected_account_indexes: [9],
        affected_line_indexes: [1],
      }),
    ];
    const warn = vi.fn();
    const out = translateLineIndexes(findings, bill, {
      auditId: 'a1',
      warn,
    });
    expect(out[0]?.affected_line_indexes).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('drops only the offending per-account local index that is out of range', () => {
    const bill = makeBill([2, 4]); // account 1 has 4 lines (locals 0-3)
    const findings = [
      makeFinding({
        affected_account_indexes: [1],
        affected_line_indexes: [0, 9, 2], // 9 is out of range
      }),
    ];
    const warn = vi.fn();
    const out = translateLineIndexes(findings, bill, {
      auditId: 'a1',
      warn,
    });
    // Globals: account 1 starts at 2 → 0→2, 2→4. The 9 is dropped.
    expect(out[0]?.affected_line_indexes).toEqual([2, 4]);
    expect(warn).toHaveBeenCalled();
  });

  it('returns a new array; original findings are not mutated', () => {
    const bill = makeBill([2, 2]);
    const original = makeFinding({
      affected_account_indexes: [1],
      affected_line_indexes: [1],
    });
    const findings = [original];
    const out = translateLineIndexes(findings, bill, {
      auditId: 'a1',
      warn: silentLogger.warn,
    });
    expect(original.affected_line_indexes).toEqual([1]); // unchanged
    expect(out[0]?.affected_line_indexes).toEqual([3]); // translated copy
    expect(out[0]).not.toBe(original);
  });

  it('handles empty bills gracefully', () => {
    const bill = makeBill([]);
    const out = translateLineIndexes([], bill, {
      auditId: 'a1',
      warn: silentLogger.warn,
    });
    expect(out).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (E2) deriveFailureReason redaction
// ───────────────────────────────────────────────────────────────────────────

describe('deriveFailureReason (E2)', () => {
  it('redacts ExtractionError.details before formatting', () => {
    const err = new ExtractionError('Schema validation failed', {
      raw: 'mdn 5551237777 acct 0001234567 plan_base 4399',
      issues: [{ path: ['accounts', 0], message: 'expected number' }],
    });
    const reason = deriveFailureReason(err);
    // Verbatim raw bill body must NOT survive into the reason string.
    expect(reason).not.toContain('5551237777');
    expect(reason).not.toContain('0001234567');
    // The schema-validation message label survives.
    expect(reason).toContain('Schema validation failed');
  });

  it('redacts an ExtractionError wrapped inside a PipelineError', () => {
    const inner = new ExtractionError('LLM returned non-JSON', {
      raw: 'pre-validation chunk with phone 5551239999',
    });
    const outer = new PipelineError('LLM extraction failed', 'llm_extract', inner);
    const reason = deriveFailureReason(outer);
    expect(reason).toContain('extraction:llm_extract');
    expect(reason).toContain('LLM extraction failed');
    expect(reason).not.toContain('5551239999');
  });

  it('formats ExtractionTimeoutError as extraction-timeout: <ms>ms', () => {
    const err = new ExtractionTimeoutError(EXTRACTION_TIMEOUT_MS);
    const reason = deriveFailureReason(err);
    expect(reason).toContain('extraction-timeout');
    expect(reason).toContain(`${EXTRACTION_TIMEOUT_MS}ms`);
  });

  it('truncates very long messages to the column limit', () => {
    const huge = 'x'.repeat(10_000);
    const err = new Error(huge);
    const reason = deriveFailureReason(err);
    expect(reason.length).toBeLessThanOrEqual(500);
  });

  it('returns "Unknown failure" for non-Error values', () => {
    expect(deriveFailureReason('plain string')).toBe('Unknown failure');
    expect(deriveFailureReason(42)).toBe('Unknown failure');
    expect(deriveFailureReason(null)).toBe('Unknown failure');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (E5) withTimeout / ExtractionTimeoutError
// ───────────────────────────────────────────────────────────────────────────

describe('withTimeout (E5)', () => {
  it('resolves with the inner promise when it beats the timer', async () => {
    const fast = Promise.resolve('done');
    const result = await withTimeout(fast, 1_000, 'fast-task');
    expect(result).toBe('done');
  });

  it('rejects with ExtractionTimeoutError when the inner promise hangs', async () => {
    // Use a never-resolving promise + a tiny timeout so the test stays fast.
    const hung = new Promise<string>(() => {
      // never resolves
    });
    let caught: unknown;
    try {
      await withTimeout(hung, 5, 'OCR');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExtractionTimeoutError);
    if (caught instanceof ExtractionTimeoutError) {
      expect(caught.afterMs).toBe(5);
      expect(caught.message).toContain('OCR');
      expect(caught.message).toContain('extraction-timeout');
    }
  });

  it('propagates inner rejections (non-timeout errors)', async () => {
    const explode = Promise.reject(new Error('boom'));
    let caught: unknown;
    try {
      await withTimeout(explode, 1_000, 'explode-task');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('boom');
    expect(caught).not.toBeInstanceOf(ExtractionTimeoutError);
  });

  it('EXTRACTION_TIMEOUT_MS leaves a buffer below the 15min Inngest cap', () => {
    expect(EXTRACTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(EXTRACTION_TIMEOUT_MS).toBeLessThan(15 * 60 * 1000);
    // Confirm we're at the spec'd 12 minutes.
    expect(EXTRACTION_TIMEOUT_MS).toBe(12 * 60 * 1000);
  });
});
