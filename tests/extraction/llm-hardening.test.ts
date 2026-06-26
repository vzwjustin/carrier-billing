/**
 * H3+H4+H6 hardening tests for `extractBill`.
 *
 * Mocks the Anthropic SDK at module-mock time so we never make a real API
 * call. Asserts the three behavioral contracts that landed with the review:
 *
 *   H3 — A response with `stop_reason: 'max_tokens'` raises ExtractionError
 *        instead of being fed back into the retry-on-validation-failure path.
 *   H4 — The request body sent to `messages.create` carries `cache_control:
 *        { type: 'ephemeral' }` on (a) the system prompt block and (b) the
 *        PDF document block.
 *   H6 — When per-account totals reconcile within tolerance the parsed bill
 *        comes back unchanged; when they don't, `confidence` is downgraded
 *        one tier (high→medium) and a Sentry warning is emitted.
 *
 * H5 (PDF size cap) lives in `tests/extraction/pipeline-size-cap.test.ts`
 * because the cap is enforced at `runExtractionPipeline` entry, not in
 * `extractBill` itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryMock = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => sentryMock);

const messagesCreateMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => {
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{}' }],
    };
  }),
);

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      public messages = { create: messagesCreateMock };
      constructor(_opts: unknown) {}
    },
  };
});

// `@/env` reads ANTHROPIC_API_KEY at import time. Stub a value so the lazy
// client construction doesn't fail; the mock above ignores it anyway.
vi.mock('@/env', () => ({ env: { ANTHROPIC_API_KEY: 'test-key' } }));

import { ExtractionError, extractBill } from '@/extraction/llm';
import type { ExtractedBill } from '@/extraction/schema';

function makeBalancedBill(overrides: Partial<ExtractedBill> = {}): ExtractedBill {
  // total = plan_base 4000 + feature 500 - credit 100 + dpp 1000 + taxes 600 = 6000
  return {
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: 6000,
    accounts: [
      {
        account_number_last4: '1234',
        label: 'Main',
        total_charges_cents: 6000,
        taxes_fees_cents: 600,
        account_level_credits: [],
        lines: [
          {
            mdn_last4: '1111',
            user_label: null,
            device: 'iPhone 14',
            plan_name: 'Business Unlimited Pro 2.0',
            plan_base_cents: 4000,
            data_used_gb: 5.5,
            voice_used_min: 0,
            sms_used_count: 0,
            is_suspended: false,
            features: [{ name: 'Mobile Protect', category: 'insurance', monthly_cents: 500 }],
            credits: [
              {
                name: 'Promo',
                monthly_cents: -100,
                expires_on: '2026-12-31',
                is_promo: true,
              },
            ],
            dpp_installments: [
              {
                device: 'iPhone 14',
                monthly_cents: 1000,
                remaining_payments: 12,
                total_payments: 36,
              },
            ],
          },
        ],
      },
    ],
    notes: [],
    ...overrides,
  };
}

const FAKE_PDF = Buffer.from('%PDF-1.4\nfake', 'binary');

beforeEach(() => {
  messagesCreateMock.mockReset();
  sentryMock.captureMessage.mockReset();
  sentryMock.captureException.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractBill — H3 token-budget truncation', () => {
  it('throws ExtractionError when stop_reason is "max_tokens"', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"carrier":"verizon"' /* truncated */ }],
    });

    await expect(extractBill(FAKE_PDF)).rejects.toBeInstanceOf(ExtractionError);

    // Critical: the bug we're guarding against is silent retry against a
    // truncated payload. Assert we made exactly ONE billable call.
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('attaches stop_reason metadata to the thrown error details', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{}' }],
    });

    let caught: unknown = null;
    try {
      await extractBill(FAKE_PDF);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExtractionError);
    const e = caught as ExtractionError;
    expect(e.message).toMatch(/token budget/i);
    const details = e.details as { stop_reason?: string };
    expect(details?.stop_reason).toBe('max_tokens');
  });
});

describe('extractBill — H4 prompt caching', () => {
  it('sends cache_control on the system block and on the PDF document block', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(makeBalancedBill()) }],
    });

    await extractBill(FAKE_PDF);

    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    const arg = messagesCreateMock.mock.calls[0]?.[0] as {
      system: Array<{ type: string; cache_control?: unknown }>;
      messages: Array<{
        content: Array<{ type: string; cache_control?: unknown }>;
      }>;
    };

    // System is sent as an array of text blocks with the cache breakpoint on
    // the (single) trailing block.
    expect(Array.isArray(arg.system)).toBe(true);
    const lastSystem = arg.system[arg.system.length - 1];
    expect(lastSystem?.cache_control).toEqual({ type: 'ephemeral' });

    // First user message contains the PDF document block; it carries the
    // breakpoint so the largest stable prefix is cached.
    const firstUserContent = arg.messages[0]?.content ?? [];
    const docBlock = firstUserContent.find((b) => b.type === 'document');
    expect(docBlock?.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('extractBill — schema-validation failure does not leak bill PII', () => {
  it('omits the raw bill candidate from ExtractionError.details, keeping only Zod issues', async () => {
    // A well-formed JSON object that FAILS the schema: `total_charges_cents`
    // is a string, and it carries un-truncated PII (full phone + account
    // number) that must NOT survive onto the thrown error's details.
    const malformed = JSON.stringify({
      carrier: 'verizon',
      billing_period_start: '2026-04-01',
      billing_period_end: '2026-04-30',
      total_charges_cents: 'not-a-number',
      account_number: '4155551234',
      contact_phone: '415-555-1234',
      accounts: [],
      notes: [],
    });
    // extractBill retries once on a schema failure, so both attempts must
    // return the malformed payload to reach the final throw.
    messagesCreateMock.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: malformed }],
    });

    let caught: unknown = null;
    try {
      await extractBill(FAKE_PDF);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ExtractionError);
    const e = caught as ExtractionError;
    expect(e.message).toMatch(/schema validation failed/i);

    const details = e.details as Record<string, unknown>;
    // The raw bill candidate must be gone entirely.
    expect(details).not.toHaveProperty('raw');
    // And no bill PII may have bled into details by any path.
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain('4155551234');
    expect(serialized).not.toContain('415-555-1234');

    // Zod issue paths are still present for diagnostics.
    const issues = details.issues as Array<{ path: unknown[]; message: string }>;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path.includes('total_charges_cents'))).toBe(true);
  });
});

describe('extractBill — H6 totals sanity check', () => {
  it('returns an unmodified bill when per-account totals reconcile', async () => {
    const bill = makeBalancedBill();
    messagesCreateMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(bill) }],
    });

    const out = await extractBill(FAKE_PDF);
    // No confidence downgrade — schema default is undefined, finalizeBill
    // leaves it as-is when reconciliation passes.
    expect(out.confidence).toBeUndefined();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });

  it('downgrades confidence high→medium and emits a Sentry warning on mismatch', async () => {
    // Inflate `total_charges_cents` by 50% so it well exceeds the 5%/100¢
    // tolerance — the LLM said the account totals 9000¢ but the line items
    // only add up to 6000¢.
    const bad = makeBalancedBill({ total_charges_cents: 9000 });
    bad.accounts[0]!.total_charges_cents = 9000;
    messagesCreateMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(bad) }],
    });

    const out = await extractBill(FAKE_PDF);
    expect(out.confidence).toBe('medium');

    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    const [msg, ctx] = sentryMock.captureMessage.mock.calls[0] ?? [];
    expect(msg).toMatch(/totals mismatch/i);
    const tags = (ctx as { tags?: Record<string, string> }).tags;
    expect(tags?.surface).toBe('extraction-totals-check');
  });

  it('further-downgrades medium→low when the LLM already returned medium', async () => {
    const bad = makeBalancedBill({
      total_charges_cents: 9000,
      confidence: 'medium',
    });
    bad.accounts[0]!.total_charges_cents = 9000;
    messagesCreateMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(bad) }],
    });

    const out = await extractBill(FAKE_PDF);
    expect(out.confidence).toBe('low');
  });

  it('tolerates sub-dollar rounding on tiny accounts (floor)', async () => {
    // A $5.00 line where the printed total rounds to $5.01 — within the
    // 100¢ floor. Must NOT downgrade.
    const bill = makeBalancedBill();
    bill.accounts[0]!.total_charges_cents = 6050;
    messagesCreateMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(bill) }],
    });

    const out = await extractBill(FAKE_PDF);
    expect(out.confidence).toBeUndefined();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });
});

describe('extractBill — billing-period coherence check', () => {
  it('downgrades confidence and appends a note when start is after end', async () => {
    // Cycle dates transposed: start 2026-04-30 after end 2026-04-01. Totals
    // still reconcile, so the only signal is the date order.
    const bill = makeBalancedBill({
      billing_period_start: '2026-04-30',
      billing_period_end: '2026-04-01',
    });
    messagesCreateMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(bill) }],
    });

    const out = await extractBill(FAKE_PDF);
    expect(out.confidence).toBe('medium');
    expect(out.notes.some((n) => /transposed/i.test(n))).toBe(true);

    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    const [msg, ctx] = sentryMock.captureMessage.mock.calls[0] ?? [];
    expect(msg).toMatch(/billing period out of order/i);
    const tags = (ctx as { tags?: Record<string, string> }).tags;
    expect(tags?.surface).toBe('extraction-period-check');
  });

  it('leaves a coherent billing period untouched', async () => {
    const bill = makeBalancedBill();
    messagesCreateMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(bill) }],
    });

    const out = await extractBill(FAKE_PDF);
    expect(out.confidence).toBeUndefined();
    expect(out.notes).toEqual([]);
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });

  it('treats a same-day cycle (start === end) as coherent', async () => {
    const bill = makeBalancedBill({
      billing_period_start: '2026-04-15',
      billing_period_end: '2026-04-15',
    });
    messagesCreateMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(bill) }],
    });

    const out = await extractBill(FAKE_PDF);
    expect(out.confidence).toBeUndefined();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });
});
