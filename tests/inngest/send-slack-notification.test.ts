import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the send-slack-notification Inngest function.
 *
 * The inner helpers (`buildHighFindingPayload`, `buildAutopsyPayload`,
 * `postToSlack`) are exported via `__testables` so we can exercise payload
 * shape + delivery without standing up an Inngest runtime. We stub global
 * `fetch` to capture outbound HTTP and assert payload contents.
 */

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    NEXT_PUBLIC_APP_URL: 'https://app.carrieraudit.test',
    INNGEST_EVENT_KEY: undefined,
  },
}));

import { functions } from '@/inngest/functions';
import {
  __testables,
  sendSlackAutopsyFn,
  sendSlackHighFindingFn,
} from '@/inngest/functions/send-slack-notification';

const { buildHighFindingPayload, buildAutopsyPayload, postToSlack, formatCents } =
  __testables;

const AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const FINDING_ID = '22222222-2222-4222-8222-222222222222';
const COMPARISON_ID = '33333333-3333-4333-8333-333333333333';

let lastCall: { input: string; init: RequestInit } | null = null;

beforeEach(() => {
  lastCall = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        lastCall = {
          input: typeof input === 'string' ? input : input.toString(),
          init: init ?? {},
        };
        return new Response('ok', { status: 200 });
      },
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registration', () => {
  it('registers both Slack notifier functions in the registry', () => {
    const ids = (functions as ReadonlyArray<{ id: () => string }>).map((fn) =>
      fn.id(),
    );
    expect(ids.some((id) => id.includes('send-slack-high-finding'))).toBe(true);
    expect(ids.some((id) => id.includes('send-slack-autopsy'))).toBe(true);
  });

  it('has stable function ids', () => {
    expect(sendSlackHighFindingFn.id()).toContain('send-slack-high-finding');
    expect(sendSlackAutopsyFn.id()).toContain('send-slack-autopsy');
  });
});

describe('formatCents', () => {
  it('formats positive whole-dollar values', () => {
    expect(formatCents(12345)).toBe('$123.45');
  });
  it('pads single-digit cents with a leading zero', () => {
    expect(formatCents(105)).toBe('$1.05');
  });
  it('handles zero', () => {
    expect(formatCents(0)).toBe('$0.00');
  });
  it('handles negative values', () => {
    expect(formatCents(-2500)).toBe('-$25.00');
  });
});

describe('buildHighFindingPayload — shape + PII discipline', () => {
  it('includes only PII-safe fields', () => {
    const payload = buildHighFindingPayload({
      auditId: AUDIT_ID,
      findingId: FINDING_ID,
      ruleId: 'autopsy_escalated_carrier_change',
      title: 'Carrier raised line access fee',
      estimatedMonthlySavingsCents: 4500,
    });

    expect(payload.text).toContain('Carrier raised line access fee');

    const serialized = JSON.stringify(payload);
    // No MDN, no account, no email patterns should ever leak through.
    expect(serialized).not.toMatch(/\b\d{3}-?\d{3}-?\d{4}\b/);
    expect(serialized).not.toMatch(/account/i);
    expect(serialized).not.toMatch(/@/); // no email-like content

    // Button URL points back to the finding anchor.
    const actions = payload.blocks.find(
      (b) => (b as { type?: string }).type === 'actions',
    ) as { elements?: Array<{ url?: string }> } | undefined;
    expect(actions?.elements?.[0]?.url).toContain(`/audits/${AUDIT_ID}`);
    expect(actions?.elements?.[0]?.url).toContain(`finding-${FINDING_ID}`);
  });

  it('renders a fallback line when there is no savings estimate', () => {
    const payload = buildHighFindingPayload({
      auditId: AUDIT_ID,
      findingId: FINDING_ID,
      ruleId: 'autopsy_escalated_unexplained',
      title: 'Unexplained $40/mo increase',
      estimatedMonthlySavingsCents: null,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toMatch(/No automatic savings estimate/);
  });

  it('renders the cents when savings > 0', () => {
    const payload = buildHighFindingPayload({
      auditId: AUDIT_ID,
      findingId: FINDING_ID,
      ruleId: 'autopsy_escalated_data_overage',
      title: 'Data overage spike',
      estimatedMonthlySavingsCents: 2500,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('$25.00');
  });
});

describe('buildAutopsyPayload — shape', () => {
  it('describes the direction (up vs. down) and disputable amount', () => {
    const payload = buildAutopsyPayload({
      comparisonId: COMPARISON_ID,
      currentAuditId: AUDIT_ID,
      disputableCents: 12_000,
      netChangeCents: 15_000,
      driversCount: 3,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('$150.00');
    expect(serialized).toMatch(/up/);
    expect(serialized).toContain('$120.00');
    expect(serialized).toContain('3'); // drivers count
    // Button URL targets the autopsy detail page.
    const actions = payload.blocks.find(
      (b) => (b as { type?: string }).type === 'actions',
    ) as { elements?: Array<{ url?: string }> } | undefined;
    expect(actions?.elements?.[0]?.url).toContain(
      `/audits/${AUDIT_ID}/autopsy/${COMPARISON_ID}`,
    );
  });

  it('handles a single change driver (no plural "s")', () => {
    const payload = buildAutopsyPayload({
      comparisonId: COMPARISON_ID,
      currentAuditId: AUDIT_ID,
      disputableCents: 500,
      netChangeCents: 500,
      driversCount: 1,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('1*');
    expect(serialized).toMatch(/driver\b/);
    expect(serialized).not.toMatch(/drivers/);
  });

  it('renders "down" when the bill decreased', () => {
    const payload = buildAutopsyPayload({
      comparisonId: COMPARISON_ID,
      currentAuditId: AUDIT_ID,
      disputableCents: 100,
      netChangeCents: -5000,
      driversCount: 2,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toMatch(/down/);
    expect(serialized).toContain('$50.00');
  });
});

describe('postToSlack — delivery', () => {
  it('POSTs JSON to the webhook URL with the Content-Type header', async () => {
    const result = await postToSlack(
      'https://hooks.slack.com/services/T0/B0/secret',
      buildHighFindingPayload({
        auditId: AUDIT_ID,
        findingId: FINDING_ID,
        ruleId: 'autopsy_escalated_test',
        title: 'Hello',
        estimatedMonthlySavingsCents: 100,
      }),
      { surface: 'slack.test' },
    );
    expect(result).toEqual({ ok: true, status: 200 });
    expect(lastCall).not.toBeNull();
    expect(lastCall!.input).toBe(
      'https://hooks.slack.com/services/T0/B0/secret',
    );
    expect(lastCall!.init.method).toBe('POST');
    const headers = lastCall!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('refuses to POST to a non-Slack URL (defense-in-depth)', async () => {
    const result = await postToSlack(
      'https://evil.example.com/webhook',
      buildHighFindingPayload({
        auditId: AUDIT_ID,
        findingId: FINDING_ID,
        ruleId: 'r',
        title: 't',
        estimatedMonthlySavingsCents: null,
      }),
      { surface: 'slack.test' },
    );
    expect(result).toEqual({ ok: false, status: null });
    // fetch was never invoked.
    expect(lastCall).toBeNull();
  });

  it('returns ok:false (does not throw) on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );
    const result = await postToSlack(
      'https://hooks.slack.com/services/T/B/x',
      buildHighFindingPayload({
        auditId: AUDIT_ID,
        findingId: FINDING_ID,
        ruleId: 'r',
        title: 't',
        estimatedMonthlySavingsCents: null,
      }),
      { surface: 'slack.test' },
    );
    expect(result).toEqual({ ok: false, status: 429 });
  });

  it('returns ok:false (does not throw) on fetch error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('econnreset');
      }),
    );
    const result = await postToSlack(
      'https://hooks.slack.com/services/T/B/x',
      buildHighFindingPayload({
        auditId: AUDIT_ID,
        findingId: FINDING_ID,
        ruleId: 'r',
        title: 't',
        estimatedMonthlySavingsCents: null,
      }),
      { surface: 'slack.test' },
    );
    expect(result).toEqual({ ok: false, status: null });
  });
});
