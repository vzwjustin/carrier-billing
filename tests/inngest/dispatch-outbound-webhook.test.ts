import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the dispatch-outbound-webhook Inngest function.
 *
 * The inner `postOutboundWebhook` is exposed via `__testables` so we can
 * verify the v2 HMAC signing, IP-pinning hand-off, and PII-safe payload shape
 * without needing an Inngest harness.
 *
 * The SSRF guard is stubbed so DNS doesn't run; the `postPinnedHttps`
 * transport is mocked so no outbound request actually fires and we can assert
 * exactly what the dispatcher hands it. The transport's own TLS/SNI/redirect
 * mechanics are covered separately in tests/lib/security/pinned-https.test.ts.
 */

vi.mock('@/lib/security/ssrf-guard', () => ({
  assertPublicHttpsTarget: vi.fn(async (_url: string) => ({
    resolvedIp: '203.0.113.10',
    family: 4 as const,
    hostname: 'hook.example.com',
  })),
  SsrfBlockedError: class extends Error {},
}));

const postPinnedHttpsMock = vi.hoisted(() => vi.fn(async (_req: unknown) => ({ status: 200 })));
vi.mock('@/lib/security/pinned-https', () => ({
  postPinnedHttps: postPinnedHttpsMock,
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    INNGEST_EVENT_KEY: undefined,
  },
}));

import {
  dispatchOutboundWebhookFn,
  __testables,
} from '@/inngest/functions/dispatch-outbound-webhook';
import { functions } from '@/inngest/functions';
import type { AuditCarrier, AuditStatus, FindingSeverity } from '@/types/db-enums';

const { postOutboundWebhook } = __testables;

const SECRET = 'whs_test_secret_value';

interface PinnedReq {
  url: URL;
  resolvedIp: string;
  family: number;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/** The argument the dispatcher handed to the (mocked) pinned transport. */
function lastReq(): PinnedReq {
  const calls = postPinnedHttpsMock.mock.calls;
  expect(calls.length, 'postPinnedHttps was not called').toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as PinnedReq;
}

interface AuditFixture {
  id: string;
  user_id: string;
  status: AuditStatus;
  carrier: AuditCarrier | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
  completed_at: string | null;
}

interface FindingFixture {
  id: string;
  rule_id: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number | null;
  confidence: number | null;
}

function makeAudit(over: Partial<AuditFixture> = {}): AuditFixture {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    user_id: '33333333-3333-4333-8333-333333333333',
    status: 'completed',
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    estimated_monthly_savings_cents: 5000,
    estimated_annual_savings_cents: 60000,
    finding_count: 3,
    high_severity_count: 1,
    completed_at: '2026-05-01T12:00:00Z',
    ...over,
  };
}

function makeFinding(over: Partial<FindingFixture> = {}): FindingFixture {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    rule_id: 'orphan_insurance',
    severity: 'medium',
    title: 'Insurance still billing on a suspended line',
    description: 'This line is suspended but is being billed $15/mo.',
    recommended_action: 'Cancel the protection plan on this line.',
    estimated_monthly_savings_cents: 1500,
    confidence: 0.9,
    ...over,
  };
}

beforeEach(() => {
  postPinnedHttpsMock.mockReset();
  postPinnedHttpsMock.mockResolvedValue({ status: 200 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('dispatchOutboundWebhookFn — registration', () => {
  it('is registered with the expected id', () => {
    expect(dispatchOutboundWebhookFn.id()).toContain('dispatch-outbound-webhook');
  });

  it('appears in the exported functions registry', () => {
    const ids = (functions as ReadonlyArray<{ id: () => string }>).map((fn) => fn.id());
    expect(ids.some((id) => id.includes('dispatch-outbound-webhook'))).toBe(true);
  });
});

describe('postOutboundWebhook — v2 HMAC signature', () => {
  it('signs `${timestamp}.${body}` with the per-user secret', async () => {
    await postOutboundWebhook({
      url: 'https://hook.example.com/path?x=1',
      secret: SECRET,
      audit: makeAudit(),
      findings: [makeFinding()],
    });

    const req = lastReq();
    const headers = req.headers;
    const body = req.body;

    const sig = headers['X-CarrierAudit-Signature'];
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig ?? '');
    expect(match, `signature header malformed: ${sig}`).not.toBeNull();
    const timestamp = match![1]!;
    const v1 = match![2]!;

    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
    expect(v1).toBe(expected);

    expect(headers['X-CarrierAudit-Timestamp']).toBe(timestamp);
    expect(headers['X-CarrierAudit-Event']).toBe('audit.completed');
    expect(headers['X-CarrierAudit-Audit-Id']).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('uses a different signature when secret rotates', async () => {
    await postOutboundWebhook({
      url: 'https://hook.example.com/path',
      secret: 'secret-a',
      audit: makeAudit(),
      findings: [],
    });
    const sigA = lastReq().headers['X-CarrierAudit-Signature'];

    await postOutboundWebhook({
      url: 'https://hook.example.com/path',
      secret: 'secret-b',
      audit: makeAudit(),
      findings: [],
    });
    const sigB = lastReq().headers['X-CarrierAudit-Signature'];

    expect(sigA).not.toBe(sigB);
  });
});

describe('postOutboundWebhook — SSRF pinning hand-off', () => {
  it('pins the connect to the resolved IP while keeping the hostname URL (so TLS SNI/cert still validate)', async () => {
    await postOutboundWebhook({
      url: 'https://hook.example.com/path',
      secret: SECRET,
      audit: makeAudit(),
      findings: [],
    });
    const req = lastReq();
    // Connect target is pinned to the vetted IP...
    expect(req.resolvedIp).toBe('203.0.113.10');
    expect(req.family).toBe(4);
    // ...but the URL (and therefore TLS SNI + cert identity) stays the hostname.
    expect(req.url.hostname).toBe('hook.example.com');
    expect(req.url.href).toContain('hook.example.com');
    expect(req.url.href).not.toContain('203.0.113.10');
  });

  it('preserves the original Host header including port', async () => {
    await postOutboundWebhook({
      url: 'https://hook.example.com:8443/cb',
      secret: SECRET,
      audit: makeAudit(),
      findings: [],
    });
    expect(lastReq().headers['Host']).toBe('hook.example.com:8443');
  });
});

describe('postOutboundWebhook — payload contract', () => {
  it('emits the audit envelope with all expected fields', async () => {
    await postOutboundWebhook({
      url: 'https://hook.example.com/path',
      secret: SECRET,
      audit: makeAudit(),
      findings: [makeFinding()],
    });

    const body = JSON.parse(lastReq().body) as {
      event: string;
      delivered_at: string;
      audit: Record<string, unknown>;
      findings: Array<Record<string, unknown>>;
    };

    expect(body.event).toBe('audit.completed');
    expect(typeof body.delivered_at).toBe('string');
    expect(body.audit).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
      user_id: '33333333-3333-4333-8333-333333333333',
      status: 'completed',
      carrier: 'verizon',
      estimated_monthly_savings_cents: 5000,
      estimated_annual_savings_cents: 60000,
      finding_count: 3,
      high_severity_count: 1,
    });
  });

  it('coerces null cents fields to 0 in the payload', async () => {
    await postOutboundWebhook({
      url: 'https://hook.example.com/path',
      secret: SECRET,
      audit: makeAudit({
        estimated_monthly_savings_cents: null,
        estimated_annual_savings_cents: null,
        finding_count: null,
        high_severity_count: null,
      }),
      findings: [makeFinding({ estimated_monthly_savings_cents: null })],
    });

    const body = JSON.parse(lastReq().body) as {
      audit: Record<string, number>;
      findings: Array<Record<string, number>>;
    };

    expect(body.audit.estimated_monthly_savings_cents).toBe(0);
    expect(body.audit.estimated_annual_savings_cents).toBe(0);
    expect(body.audit.finding_count).toBe(0);
    expect(body.audit.high_severity_count).toBe(0);
    expect(body.findings[0]?.estimated_monthly_savings_cents).toBe(0);
  });

  it('does NOT include raw bill data, MDN, or phone numbers in the audit envelope', async () => {
    await postOutboundWebhook({
      url: 'https://hook.example.com/path',
      secret: SECRET,
      audit: makeAudit(),
      findings: [makeFinding()],
    });
    const body = JSON.parse(lastReq().body) as {
      audit: Record<string, unknown>;
    };
    expect(body.audit).not.toHaveProperty('extracted_bill');
    expect(body.audit).not.toHaveProperty('bill');
    expect(body.audit).not.toHaveProperty('lines');
    expect(body.audit).not.toHaveProperty('accounts');
    expect(body.audit).not.toHaveProperty('mdn');
    expect(body.audit).not.toHaveProperty('phone_number');
  });
});

describe('postOutboundWebhook — retry-on-non-2xx', () => {
  it('throws on 5xx so Inngest retries', async () => {
    postPinnedHttpsMock.mockResolvedValue({ status: 503 });
    await expect(
      postOutboundWebhook({
        url: 'https://hook.example.com/path',
        secret: SECRET,
        audit: makeAudit(),
        findings: [],
      }),
    ).rejects.toThrow(/webhook 503/);
  });

  it('throws on 4xx too (rotating-secret 401 looks the same as a permanent reject)', async () => {
    postPinnedHttpsMock.mockResolvedValue({ status: 401 });
    await expect(
      postOutboundWebhook({
        url: 'https://hook.example.com/path',
        secret: SECRET,
        audit: makeAudit(),
        findings: [],
      }),
    ).rejects.toThrow(/webhook 401/);
  });

  it('returns the success status code for a 200', async () => {
    const result = await postOutboundWebhook({
      url: 'https://hook.example.com/path',
      secret: SECRET,
      audit: makeAudit(),
      findings: [],
    });
    expect(result).toEqual({ status: 200 });
  });
});
