import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the dispatch-finding-webhook Inngest function.
 *
 * The inner `postFindingWebhook` is exported via `__testables` so we can
 * exercise the signing + IP-pinning hand-off directly without standing up an
 * Inngest runtime. We mock the SSRF guard to short-circuit DNS (test env has
 * no network) and mock the `postPinnedHttps` transport to capture the
 * outbound request. The transport's TLS/SNI/redirect mechanics are covered in
 * tests/lib/security/pinned-https.test.ts.
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
  dispatchFindingWebhookFn,
  __testables,
} from '@/inngest/functions/dispatch-finding-webhook';
import { functions } from '@/inngest/functions';
import type { FindingSeverity } from '@/types/db-enums';

const { postFindingWebhook } = __testables;

const SECRET = 'whs_test_secret_value';

interface PinnedReq {
  url: URL;
  resolvedIp: string;
  family: number;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

function lastReq(): PinnedReq {
  const calls = postPinnedHttpsMock.mock.calls;
  expect(calls.length, 'postPinnedHttps was not called').toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as PinnedReq;
}

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

beforeEach(() => {
  postPinnedHttpsMock.mockReset();
  postPinnedHttpsMock.mockResolvedValue({ status: 200 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('dispatchFindingWebhookFn registration', () => {
  it('is registered in the functions registry', () => {
    const ids = (functions as ReadonlyArray<{ id: () => string }>).map((fn) => fn.id());
    expect(ids.some((id) => id.includes('dispatch-finding-webhook'))).toBe(true);
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

    const req = lastReq();
    const headers = req.headers;
    const body = req.body;
    expect(typeof body).toBe('string');

    const sig = headers['X-CarrierAudit-Signature'];
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig ?? '');
    expect(match, `signature header malformed: ${sig}`).not.toBeNull();
    const timestamp = match![1]!;
    const v1 = match![2]!;

    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
    expect(v1).toBe(expected);

    expect(headers['X-CarrierAudit-Timestamp']).toBe(timestamp);
    expect(headers['X-CarrierAudit-Event']).toBe('finding.status_changed');
    expect(headers['X-CarrierAudit-Audit-Id']).toBe('22222222-2222-4222-8222-222222222222');
    expect(headers['X-CarrierAudit-Finding-Id']).toBe('11111111-1111-4111-8111-111111111111');
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

    const body = JSON.parse(lastReq().body) as {
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
    expect(body.finding).not.toHaveProperty('mdn_last4');
    expect(body.finding).not.toHaveProperty('description');
    expect(body.finding).not.toHaveProperty('evidence');
  });

  it('pins to the resolved IP while keeping the hostname URL and Host header', async () => {
    await postFindingWebhook({
      url: 'https://hook.example.com:8443/cb',
      secret: SECRET,
      auditId: '22222222-2222-4222-8222-222222222222',
      findingId: '11111111-1111-4111-8111-111111111111',
      status: 'rejected',
      previousStatus: 'approved',
      finding: makeFinding(),
    });

    const req = lastReq();
    expect(req.resolvedIp).toBe('203.0.113.10');
    expect(req.family).toBe(4);
    expect(req.url.hostname).toBe('hook.example.com');
    expect(req.url.href).not.toContain('203.0.113.10');
    // Original host:port preserved for vhost routing.
    expect(req.headers['Host']).toBe('hook.example.com:8443');
  });
});

describe('postFindingWebhook — retry-on-5xx', () => {
  it('throws on non-2xx so Inngest retries (5xx)', async () => {
    postPinnedHttpsMock.mockResolvedValue({ status: 503 });
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
    postPinnedHttpsMock.mockResolvedValue({ status: 401 });
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
