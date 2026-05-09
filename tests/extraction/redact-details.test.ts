import { describe, expect, it } from 'vitest';

import { ExtractionError, redactDetails } from '@/extraction/llm';

/**
 * (E2) Redaction of ExtractionError.details before logs cross a boundary.
 *
 * Per CLAUDE.md §1#9 we cannot leak raw bill content (employee names, phone
 * numbers, account numbers, dollar figures) into logs or `audits.failure_reason`.
 * `redactDetails()` is the safety net for the failure path: process-bill calls
 * it before stuffing details into the failure-reason string.
 */

describe('redactDetails', () => {
  it('strips the top-level `raw` key', () => {
    const out = redactDetails({
      raw: 'JOHN DOE 555-867-5309 acct ****1234 plan_base 4399',
      ok: true,
    }) as Record<string, unknown>;
    expect(out.raw).toBe('[REDACTED]');
    expect(out.ok).toBe(true);
  });

  it('strips top-level `text` and `content` keys', () => {
    const out = redactDetails({
      text: 'page 1 of 12 ... 555-867-5309',
      content: [{ type: 'text', text: 'verbatim bill body' }],
    }) as Record<string, unknown>;
    expect(out.text).toBe('[REDACTED]');
    expect(out.content).toBe('[REDACTED]');
  });

  it('scrubs digit runs of 4+ characters in surviving string fields', () => {
    const out = redactDetails({
      issues: [{ path: ['accounts', 0, 'lines', 1], message: 'expected number' }],
      summary: 'phone last4 is 5309 and account is 1234567',
    }) as Record<string, unknown>;
    const summary = out.summary;
    expect(typeof summary).toBe('string');
    // 4+ digit runs replaced; "0" / "1" tokens (single digits) untouched.
    expect(summary).not.toMatch(/5309/);
    expect(summary).not.toMatch(/1234567/);
    expect(summary).toMatch(/\[REDACTED\]/);
  });

  it('walks nested objects', () => {
    const out = redactDetails({
      cause: {
        raw: 'leaky bill 5551112222',
        nested: {
          text: 'employee Jane',
          ok: 1,
        },
      },
    }) as { cause: { raw: unknown; nested: { text: unknown; ok: unknown } } };
    expect(out.cause.raw).toBe('[REDACTED]');
    expect(out.cause.nested.text).toBe('[REDACTED]');
    expect(out.cause.nested.ok).toBe(1);
  });

  it('walks arrays', () => {
    const out = redactDetails([
      { raw: 'leak', text: 'leak2' },
      { ok: true, account_last4: '1234' },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]?.raw).toBe('[REDACTED]');
    expect(out[0]?.text).toBe('[REDACTED]');
    expect(out[1]?.ok).toBe(true);
    // The `account_last4` key isn't blocklisted, but the digit-run scrubber
    // still cleans the value.
    expect(out[1]?.account_last4).toBe('[REDACTED]');
  });

  it('caps very long string values', () => {
    const long = 'x'.repeat(2000);
    const out = redactDetails({ note: long }) as { note: string };
    expect(out.note.length).toBeLessThanOrEqual(501); // 500 + ellipsis
    expect(out.note.endsWith('…')).toBe(true);
  });

  it('handles primitive inputs without crashing', () => {
    expect(redactDetails(null)).toBeNull();
    expect(redactDetails(undefined)).toBeUndefined();
    expect(redactDetails(42)).toBe(42);
    expect(redactDetails(true)).toBe(true);
    expect(redactDetails('phone 5309')).toBe('phone [REDACTED]');
  });

  it('returns a NEW object (does not mutate the input)', () => {
    const input = { raw: 'sensitive', ok: true };
    const out = redactDetails(input) as Record<string, unknown>;
    expect(input.raw).toBe('sensitive'); // original untouched
    expect(out.raw).toBe('[REDACTED]'); // copy redacted
  });

  it('drops functions / symbols silently', () => {
    const out = redactDetails({
      fn: () => 1,
      sym: Symbol('x'),
      ok: 'plain',
    }) as Record<string, unknown>;
    expect(out.fn).toBeUndefined();
    expect(out.sym).toBeUndefined();
    expect(out.ok).toBe('plain');
  });

  it('handles a realistic ExtractionError details payload', () => {
    // Mirror what `tryParseAndValidate` produces on schema failure:
    // { issues, raw: <parsed bill object> }.
    const err = new ExtractionError('Schema validation failed', {
      issues: [
        {
          path: ['accounts', 0, 'lines', 0, 'plan_base_cents'],
          message: 'expected number, received string',
          code: 'invalid_type',
        },
      ],
      raw: {
        accounts: [
          { lines: [{ user_label: 'JANE DOE', mdn_last4: '5309' }] },
        ],
      },
    });

    const safe = redactDetails(err.details) as Record<string, unknown>;
    expect(safe.issues).toBeDefined();
    expect(safe.raw).toBe('[REDACTED]');
    // Sanity: nothing in the JSON serialization should contain the leaked PII.
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('JANE DOE');
    expect(serialized).not.toContain('5309');
  });
});
