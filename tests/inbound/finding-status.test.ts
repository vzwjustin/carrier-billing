import { beforeEach, describe, expect, it, vi } from 'vitest';

type ProfileRow = { id: string } | null;
type FindingRow = {
  id: string;
  audit_id: string;
  status: string;
  audits: { id: string; user_id: string } | null;
} | null;
type DbResp<T> = { data: T; error: null | { message: string; code?: string } };

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const UNKNOWN_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const FINDING_ID = '22222222-2222-4222-8222-222222222222';

const {
  profileSelectMock,
  findingSelectMock,
  findingUpdateMock,
  inngestSendMock,
  consumeRateLimitMock,
} = vi.hoisted(() => ({
  profileSelectMock: vi.fn<() => Promise<DbResp<ProfileRow>>>(),
  findingSelectMock: vi.fn<() => Promise<DbResp<FindingRow>>>(),
  findingUpdateMock:
    vi.fn<() => Promise<{ error: null | { message: string } }>>(),
  inngestSendMock: vi.fn(async (_event: unknown) => undefined),
  consumeRateLimitMock: vi.fn(),
}));

function makeFromChain(table: string) {
  if (table === 'profiles') {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => profileSelectMock(),
        }),
      }),
    };
  }
  if (table === 'findings') {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => findingSelectMock(),
          }),
        }),
      }),
      update: (_payload: unknown) => ({
        eq: () => ({
          eq: () => findingUpdateMock(),
        }),
      }),
    };
  }
  throw new Error(`unexpected table in mock: ${table}`);
}

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => makeFromChain(table),
  }),
}));

vi.mock('@/inngest/client', () => ({
  inngest: { send: (event: unknown) => inngestSendMock(event) },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: consumeRateLimitMock,
  rateLimitedResponse: (resetAt: string) =>
    Response.json(
      {
        error: 'rate_limited',
        message: 'Too many requests. Please try again later.',
      },
      { status: 429, headers: { 'Retry-After': '60', 'X-Reset-At': resetAt } },
    ),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    INNGEST_EVENT_KEY: undefined,
  },
}));

const { POST } = await import('@/app/api/inbound/finding-status/route');

function validBody(note = 'Approved via Slack automation.') {
  return {
    audit_id: AUDIT_ID,
    finding_id: FINDING_ID,
    status: 'approved',
    note,
  };
}

function makeReq(opts: {
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  contentLength?: string;
  forwardedFor?: string;
}): Request {
  const rawBody =
    opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (opts.token !== null && opts.token !== undefined) {
    headers.set('X-CarrierAudit-Token', opts.token);
  }
  if (opts.contentLength !== undefined) {
    headers.set('Content-Length', opts.contentLength);
  } else if (rawBody !== undefined) {
    headers.set('Content-Length', String(Buffer.byteLength(rawBody, 'utf8')));
  }
  if (opts.forwardedFor) {
    headers.set('X-Forwarded-For', opts.forwardedFor);
  }

  return new Request('http://localhost/api/inbound/finding-status', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

function allowRateLimit(resetAt = '2026-06-02T12:00:00.000Z') {
  return { ok: true, remaining: 99, resetAt };
}

beforeEach(() => {
  profileSelectMock.mockReset();
  findingSelectMock.mockReset();
  findingUpdateMock.mockReset();
  inngestSendMock.mockReset();
  consumeRateLimitMock.mockReset();

  consumeRateLimitMock.mockResolvedValue(allowRateLimit());
  profileSelectMock.mockResolvedValue({
    data: { id: PROFILE_ID },
    error: null,
  });
  findingSelectMock.mockResolvedValue({
    data: {
      id: FINDING_ID,
      audit_id: AUDIT_ID,
      status: 'in_review',
      audits: { id: AUDIT_ID, user_id: PROFILE_ID },
    },
    error: null,
  });
  findingUpdateMock.mockResolvedValue({ error: null });
});

describe('POST /api/inbound/finding-status hardening', () => {
  it('rate-limits a shape-valid unknown token before profile lookup', async () => {
    consumeRateLimitMock
      .mockResolvedValueOnce(allowRateLimit())
      .mockResolvedValueOnce({
        ok: false,
        remaining: 0,
        resetAt: '2026-06-02T12:00:00.000Z',
      });

    const res = await POST(
      makeReq({
        token: UNKNOWN_TOKEN,
        body: validBody(),
        forwardedFor: '203.0.113.10',
      }),
    );

    expect(res.status).toBe(429);
    expect(profileSelectMock).not.toHaveBeenCalled();
    expect(findingSelectMock).not.toHaveBeenCalled();
    expect(findingUpdateMock).not.toHaveBeenCalled();
    expect(consumeRateLimitMock).toHaveBeenCalledTimes(2);
    const tokenBucket = consumeRateLimitMock.mock.calls[1]?.[0] as {
      key: string;
      limit: number;
    };
    expect(tokenBucket.key).toMatch(/^inbound-finding-status-public-token:/);
    expect(tokenBucket.key).not.toContain(UNKNOWN_TOKEN);
    expect(tokenBucket.limit).toBe(60);
  });

  it('preserves valid profile token limiting and updates the finding', async () => {
    const res = await POST(
      makeReq({
        token: TOKEN,
        body: validBody(),
        forwardedFor: '198.51.100.20',
      }),
    );

    expect(res.status).toBe(200);
    expect(profileSelectMock).toHaveBeenCalledTimes(1);
    expect(findingUpdateMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);

    const calls = consumeRateLimitMock.mock.calls.map((call) => call[0]) as Array<{
      key: string;
      limit: number;
      windowSeconds: number;
    }>;
    expect(calls).toHaveLength(3);
    expect(calls[0]?.key).toMatch(/^inbound-finding-status-public-source:/);
    expect(calls[1]?.key).toMatch(/^inbound-finding-status-public-token:/);
    expect(calls[1]?.key).not.toContain(TOKEN);
    expect(calls[2]).toEqual({
      key: `inbound-finding-status:${PROFILE_ID}`,
      limit: 120,
      windowSeconds: 60,
    });
  });

  it('rejects an oversized body before JSON parsing or profile lookup', async () => {
    const res = await POST(
      makeReq({
        token: TOKEN,
        rawBody: '{"audit_id":',
        contentLength: String(17 * 1024),
      }),
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Payload too large.');
    expect(profileSelectMock).not.toHaveBeenCalled();
    expect(findingSelectMock).not.toHaveBeenCalled();
    expect(findingUpdateMock).not.toHaveBeenCalled();
  });

  it('keeps error responses free of token, note, and identifiers', async () => {
    const secretNote = 'customer email: owner@example.com, phone 555-1212';
    profileSelectMock.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(
      makeReq({
        token: UNKNOWN_TOKEN,
        body: validBody(secretNote),
      }),
    );

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(UNKNOWN_TOKEN);
    expect(text).not.toContain(secretNote);
    expect(text).not.toContain(AUDIT_ID);
    expect(text).not.toContain(FINDING_ID);
    expect(text).toBe('{"error":"Unauthorized."}');
  });
});
