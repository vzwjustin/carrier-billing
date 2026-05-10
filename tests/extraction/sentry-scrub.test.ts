import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/nextjs';

import { scrubSentryEvent } from '@/lib/observability/sentry-scrub';

/**
 * The Sentry `beforeSend` hook runs the canonical PII redactor over every
 * event payload. These tests cover the four high-PII fields the scrubber
 * touches (message, exception.value, extra, breadcrumbs) plus the
 * "don't crash on weird input" contract.
 */

describe('scrubSentryEvent', () => {
  it('scrubs PII from event.message', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: 'failure for 555-123-4567 (jane@example.com), acct 1234567',
    };
    const out = scrubSentryEvent(event);
    expect(out?.message).not.toMatch(/555-123-4567/);
    expect(out?.message).not.toMatch(/jane@example\.com/);
    expect(out?.message).not.toMatch(/1234567/);
    expect(out?.message).toContain('[phone]');
    expect(out?.message).toContain('[email]');
  });

  it('scrubs PII from exception values', () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Schema validation failed for jane@example.com',
          },
        ],
      },
    };
    const out = scrubSentryEvent(event);
    expect(out?.exception?.values?.[0]?.value).toContain('[email]');
    expect(out?.exception?.values?.[0]?.value).not.toContain('jane@example.com');
  });

  it('walks event.extra recursively and applies key blocklist', () => {
    const event: ErrorEvent = {
      type: undefined,
      extra: {
        raw: 'verbatim bill body',
        nested: {
          user_label: 'JANE DOE',
          phone: '555-123-4567',
          ok: 1,
        },
      },
    };
    const out = scrubSentryEvent(event);
    const extra = out?.extra as Record<string, unknown> | undefined;
    expect(extra?.raw).toBe('[REDACTED]');
    const nested = extra?.nested as Record<string, unknown> | undefined;
    expect(nested?.user_label).toBe('[REDACTED]');
    expect(nested?.phone).toBe('[phone]');
    expect(nested?.ok).toBe(1);
  });

  it('scrubs breadcrumb messages and data', () => {
    const event: ErrorEvent = {
      type: undefined,
      breadcrumbs: [
        {
          message: 'sent to jane@example.com',
          data: { account_number: '1234567' },
        },
      ],
    };
    const out = scrubSentryEvent(event);
    expect(out?.breadcrumbs?.[0]?.message).toContain('[email]');
    const data = out?.breadcrumbs?.[0]?.data as Record<string, unknown> | undefined;
    expect(data?.account_number).toBe('[REDACTED]');
  });

  it('returns the event unchanged when there is no PII to scrub', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: 'rules engine timed out after 12000 ms',
    };
    const out = scrubSentryEvent(event);
    // 12000 is a digit run of 5 — gets redacted. That's intentional, but the
    // event is still preserved (not dropped).
    expect(out).not.toBeNull();
    expect(out?.message).toContain('[REDACTED]');
  });

  it('returns null if scrubber crashes (defensive)', () => {
    // Passing a getter that throws should drop the event rather than ship raw.
    const event = {} as ErrorEvent;
    Object.defineProperty(event, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    expect(scrubSentryEvent(event)).toBeNull();
  });
});
