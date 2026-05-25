import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the dispatch-finding-webhook Inngest function.
 *
 * The inner `postFindingWebhook` is exported via `__testables` so we can
 * exercise the signing + fetch path directly without standing up an Inngest
 * runtime. We mock the SSRF guard to short-circuit DNS (test env has no
 * network) and stub global `fetch` to capture the outbound request.
 */

vi.mock('@/lib/security/ssrf-guard', () => ({
  assertPublicHttpsTarget: vi.fn(async (_url: string) => ({
    resolvedIp: '203.0.113.10',
    family: 4 as const,
    hostname: 'hook.example.com',
  })),
  SsrfBlockedError: class extends Error {},
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    INNGEST_EVENT_KEY: undefined,
  },
}));

import {
  dispatchFindingWebhookFn,
  __testables,
} from '@/inngest/functions/dispatch-finding-webhook';
import { functions } from '@/inngest/functions';
import type { FindingSeverity } from '@/types/db-enums';

const { postFindingWebhook } = __testables;

const SECRET = 'whs_test_secret_value';

interface FindingFixture {
  id: string;
  audit_id: string;
  rule_id: string;
  severity: FindingSeverity;
  title: string;
  status: string;
  estimated_monthly_savings_cents: number | null;
}

function makeFinding(overrides: Partial<FindingFixture> = {}): FindingFixture {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    audit_id: '22222222-2222-4222-8222-222222222222',
    rule_id: 'orphaned-line',
    severity: 'high',
    title: 'Unused line for 60+ days',
    status: 'approved',
    estimated_monthly_savings_cents: 4500,
    ...overrides,
  };
}

// Capture the last fetch call so each test can assert headers / body.
let lastCall: { input: string; init: RequestInit } | null = null;

beforeEach(() => {
  lastCall = null;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      lastCall = {
        input: typeof input === 'string' ? input : input.toString(),
        init: init ?? {},
      };
      return new Response('{}', { status: 200 });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dispatchFindingWebhookFn registration', () => {
  it('is registered in the functions registry', () => {
    const ids = (functions as ReadonlyArray<{ id: () => string }>).map((fn) =>
      fn.id(),
    );
    expect(ids.some((id) => id.includes('dispatch-finding-webhook'))).toBe(
      true,
    );
  });

  it('has the expected function id', () => {
    expect(dispatchFindingWebhookFn.id()).toContain('dispatch-finding-webhook');
  });
});

describe('postFindingWebhook — HMAC signature', () => {
  it('signs `${timestamp}.${body}` with the per-user secret', async () => {
    await postFindingWebhook({
      url: 'https://hook.example.com/path?x=1',
      secret: SECRET,
      auditId: '22222222-2222-4222-8222-222222222222',
      findingId: '11111111-1111-4111-8111-111111111111',
      status: 'approved',
      previousStatus: 'in_review',
      finding: makeFinding(),
    });

    expect(lastCall).not.toBeNull();
    const headers = lastCall!.init.headers as Record<string, string>;
    const body = lastCall!.init.body as string;
    expect(typeof body).toBe('string');

    // Pull the timestamp + v1 hex out of the signature header.
    const sig = headers['X-CarrierAudit-Signature'];
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig ?? '');
    expect(match, `signature header malformed: ${sig}`).not.toBeNull();
    const timestamp = match![1]!;
    const v1 = match![2]!;

    // Recompute the HMAC the same way the receiver should.
    const expected = createHmac('sha256', SECRET)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    expect(v1).toBe(expected);

    // Timestamp header matches the signature header timestamp.
    expect(headers['X-CarrierAudit-Timestamp']).toBe(timestamp);

    // Event + ID headers — receivers may route on these.
    expect(headers['X-CarrierAudit-Event']).toBe('finding.status_changed');
    expect(headers['X-CarrierAudit-Audit-Id']).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(headers['X-CarrierAudit-Finding-Id']).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('includes only PII-safe finding fields in the payload', async () => {
    await postFindingWebhook({
      url: 'https://hook.example.com/path',
      secret: SECRET,
      auditId: '22222222-2222-4222-8222-222222222222',
      findingId: '11111111-1111-4111-8111-111111111111',
      status: 'approved',
      previousStatus: 'in_review',
      finding: makeFinding(),
    });

    const body = JSON.parse(lastCall!.init.body as string) as {
      event: string;
      audit_id: string;
      finding_id: string;
      status: string;
      previous_status: string;
      finding: Record<string, unknown>;
    };

    expect(body.event).toBe('finding.status_changed');
    expect(body.status).toBe('approved');
    expect(body.previous_status).toBe('in_review');
    expect(body.finding).toMatchObject({
      rule_id: 'orphaned-line',
      severity: 'high',
      title: 'Unused line for 60+ days',
      estimated_monthly_savings_cents: 4500,
      status: 'approved',
    });
    // PII-safe: no MDN, no description (which can carry account context), no
    // raw extracted bill data.
    expect(body.finding).not.toHaveProperty('mdn_last4');
    expect(body.finding).not.toHaveProperty('description');
    expect(body.finding).not.toHaveProperty('evidence');
  });

  it('preserves the original Host header even when connecting to a pinned IP', async () => {
    await postFindingWebhook({
      url: 'https://hook.example.com:8443/cb',
      secret: SECRET,
      auditId: '22222222-2222-4222-8222-222222222222',
      findingId: '11111111-1111-4111-8111-111111111111',
      status: 'rejected',
      previousStatus: 'approved',
      finding: makeFinding(),
    });

    expect(lastCall!.input).toContain('203.0.113.10');
    const headers = lastCall!.init.headers as Record<string, string>;
    // Original host:port is preserved for TLS/SNI correctness.
    expect(headers['Host']).toBe('hook.example.com:8443');
  });
});

describe('postFindingWebhook — retry-on-5xx', () => {
  it('throws on non-2xx so Inngest retries (5xx)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    );

    await expect(
      postFindingWebhook({
        url: 'https://hook.example.com/path',
        secret: SECRET,
        auditId: '22222222-2222-4222-8222-222222222222',
        findingId: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
        previousStatus: null,
        finding: makeFinding(),
      }),
    ).rejects.toThrow(/webhook 503/);
  });

  it('throws on 4xx too — receiver-side rotation looks indistinguishable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    );

    await expect(
      postFindingWebhook({
        url: 'https://hook.example.com/path',
        secret: SECRET,
        auditId: '22222222-2222-4222-8222-222222222222',
        findingId: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
        previousStatus: null,
        finding: makeFinding(),
      }),
    ).rejects.toThrow(/webhook 401/);
  });

  it('returns successfully for a 200', async () => {
    const result = await postFindingWebhook({
      url: 'https://hook.example.com/path',
      secret: SECRET,
      auditId: '22222222-2222-4222-8222-222222222222',
      findingId: '11111111-1111-4111-8111-111111111111',
      status: 'approved',
      previousStatus: null,
      finding: makeFinding(),
    });
    expect(result).toEqual({ status: 200 });
  });
});
