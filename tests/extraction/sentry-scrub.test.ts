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

  it('scrubs request.url query strings (e.g. share tokens, embedded emails)', () => {
    // Share-route URLs leak the anonymous bearer token in the query string,
    // and crash-report URLs sometimes embed a contact email. scrubString
    // collapses both via the email regex and the phone/digit-run regex.
    const shareToken = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: `https://carrieraudit.com/share/${shareToken}?token=${shareToken}&contact=jane@example.com`,
      },
    };
    const out = scrubSentryEvent(event);
    expect(out?.request?.url).not.toContain('jane@example.com');
    expect(out?.request?.url).not.toContain(shareToken);
    expect(out?.request?.url).toContain('[email]');
    expect(out?.request?.url).toContain('/share/[REDACTED]');
    expect(out?.request?.url).toContain('token=[REDACTED]');
  });

  it('drops Cookie / Authorization / Referer request headers', () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        headers: {
          Cookie: 'sb-access-token=eyJhbGciOiJIUzI1NiJ9.payload.sig',
          Authorization: 'Bearer secret-token-1234567890',
          Referer: 'https://carrieraudit.com/share/secret-token',
          'User-Agent': 'Mozilla/5.0',
          'X-Trace-Id': 'callback at jane@example.com',
        },
      },
    };
    const out = scrubSentryEvent(event);
    const headers = out?.request?.headers as Record<string, string> | undefined;
    expect(headers?.Cookie).toBe('[REDACTED]');
    expect(headers?.Authorization).toBe('[REDACTED]');
    expect(headers?.Referer).toBe('[REDACTED]');
    // Non-credential headers stay but are scrubbed for embedded PII.
    expect(headers?.['User-Agent']).toBe('Mozilla/5.0');
    expect(headers?.['X-Trace-Id']).toContain('[email]');
  });

  it('scrubs event.user fields', () => {
    const event: ErrorEvent = {
      type: undefined,
      user: {
        email: 'jane@example.com',
        id: 'user-1234567',
        username: 'callback 555-123-4567',
        ip_address: '192.168.0.1',
      },
    };
    const out = scrubSentryEvent(event);
    const user = out?.user as Record<string, string> | undefined;
    expect(user?.email).toBe('[email]');
    expect(user?.id).toContain('[REDACTED]');
    expect(user?.username).toContain('[phone]');
  });

  it('scrubs event.tags values', () => {
    const event: ErrorEvent = {
      type: undefined,
      tags: {
        carrier: 'verizon',
        rule_id: 'expired-promo-credit',
        contact: 'jane@example.com',
        callback: '555-123-4567',
      },
    };
    const out = scrubSentryEvent(event);
    const tags = out?.tags as Record<string, string> | undefined;
    expect(tags?.carrier).toBe('verizon');
    expect(tags?.rule_id).toBe('expired-promo-credit');
    expect(tags?.contact).toBe('[email]');
    expect(tags?.callback).toBe('[phone]');
  });

  it('scrubs request.data (webhook/POST body) with redactDetails', () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: 'https://carrieraudit.com/api/inbound/email',
        data: {
          // 'raw' is a REDACTED_KEY — key-level drop.
          raw: 'verbatim email body',
          // 'body_text' is not a REDACTED_KEY — value-level scrub.
          body_text: 'Attached bill for jane@example.com',
          phone_number: '555-867-5309',
        },
      },
    };
    const out = scrubSentryEvent(event);
    const data = out?.request?.data as Record<string, unknown> | undefined;
    // Key-level drop for REDACTED_KEYS member.
    expect(data?.raw).toBe('[REDACTED]');
    // Key-level drop for phone_number.
    expect(data?.phone_number).toBe('[REDACTED]');
    // Value-level scrub: email address replaced in free-text field.
    const bodyText = data?.body_text as string;
    expect(bodyText).not.toContain('jane@example.com');
    expect(bodyText).toContain('[email]');
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
