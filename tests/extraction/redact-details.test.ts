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

  it('replaces email addresses with [email]', () => {
    const out = redactDetails({
      summary: 'subscriber jane.doe+billing@example.co.uk reported issue',
    }) as { summary: string };
    expect(out.summary).not.toMatch(/jane\.doe/);
    expect(out.summary).not.toMatch(/example\.co\.uk/);
    expect(out.summary).toContain('[email]');
  });

  it('replaces hyphenated phone numbers with [phone]', () => {
    const out = redactDetails({
      summary: 'callback at 555-123-4567 about line',
    }) as { summary: string };
    expect(out.summary).not.toMatch(/555-123-4567/);
    expect(out.summary).toContain('[phone]');
  });

  it('replaces dotted/spaced phone numbers with [phone]', () => {
    const out = redactDetails({
      a: '555.123.4567',
      b: '555 123 4567',
    }) as { a: string; b: string };
    expect(out.a).toBe('[phone]');
    expect(out.b).toBe('[phone]');
  });

  it('replaces all four common phone formats with [phone]', () => {
    // Hyphenated, dotted, space-separated, and parens-wrapped should all
    // collapse to [phone]. Parens form is the one that previously slipped
    // through the regex.
    const out = redactDetails({
      hyphen: 'call 555-123-4567 today',
      dot: 'call 555.123.4567 today',
      space: 'call 555 123 4567 today',
      parens: 'call (555) 123-4567 today',
    }) as { hyphen: string; dot: string; space: string; parens: string };
    expect(out.hyphen).toContain('[phone]');
    expect(out.hyphen).not.toMatch(/555-123-4567/);
    expect(out.dot).toContain('[phone]');
    expect(out.dot).not.toMatch(/555\.123\.4567/);
    expect(out.space).toContain('[phone]');
    expect(out.space).not.toMatch(/555 123 4567/);
    expect(out.parens).toContain('[phone]');
    expect(out.parens).not.toMatch(/\(555\) 123-4567/);
  });

  it('redacts every email-envelope and device-identifier key', () => {
    // Inbound webhook payloads, outbound email logs, Stripe invoice URLs,
    // and device identifiers all need to vanish from logs unconditionally
    // — the values can be anything from a plain string to a structured
    // recipient list, so we trust the key blocklist.
    const out = redactDetails({
      from: 'jane.doe@example.com',
      to: 'inbound+token@inbound.carrieraudit.com',
      recipient: 'Jane Doe <jane@example.com>',
      subject: 'Your March bill from Verizon',
      customer_email: 'jane@example.com',
      customerEmail: 'jane@example.com',
      device_serial: 'F2LZX0AAJC6L',
      imei: '356938035643809',
      hosted_invoice_url:
        'https://invoice.stripe.com/i/acct_x/test_aBcDeF1234567890?secret=foo',
      ok: true,
    }) as Record<string, unknown>;
    expect(out.from).toBe('[REDACTED]');
    expect(out.to).toBe('[REDACTED]');
    expect(out.recipient).toBe('[REDACTED]');
    expect(out.subject).toBe('[REDACTED]');
    expect(out.customer_email).toBe('[REDACTED]');
    expect(out.customerEmail).toBe('[REDACTED]');
    expect(out.device_serial).toBe('[REDACTED]');
    expect(out.imei).toBe('[REDACTED]');
    expect(out.hosted_invoice_url).toBe('[REDACTED]');
    expect(out.ok).toBe(true);
  });

  it('redacts user_label values entirely (key blocklist)', () => {
    // Names extracted via X12 REF*EM live in `user_label`. Treat the key as
    // PII regardless of value shape, so an all-caps "JANE DOE" or a plain
    // "Jane Doe" both vanish without relying on heuristic name detection.
    const out = redactDetails({
      issues: [
        {
          path: ['accounts', 0, 'lines', 0],
          message: 'expected number',
          input: { user_label: 'JANE DOE', mdn_last4: '4321' },
        },
      ],
    }) as { issues: Array<{ input: Record<string, unknown> }> };
    const input = out.issues[0]?.input;
    expect(input?.user_label).toBe('[REDACTED]');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('JANE DOE');
  });

  it('does not over-redact benign carrier brand names like AT&T', () => {
    // Plan/feature names like "AT&T Mobile Insurance" or "Business Unlimited"
    // contain no PII — the scrubbers (digit-run, email, phone) must not strip
    // them. Verify by passing them through fields that are NOT key-blocklisted.
    const out = redactDetails({
      plan_name: 'AT&T Business Unlimited Premium',
      feature_name: 'Verizon Cloud',
      device_label: 'iPhone 15 Pro Max',
    }) as Record<string, string>;
    expect(out.plan_name).toBe('AT&T Business Unlimited Premium');
    expect(out.feature_name).toBe('Verizon Cloud');
    expect(out.device_label).toBe('iPhone 15 Pro Max');
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
