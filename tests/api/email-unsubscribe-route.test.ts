import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for GET/POST /api/email/unsubscribe.
 *
 * Security properties under test:
 *   1. Constant-response: invalid tokens get the same SUCCESS_HTML the valid
 *      branch returns. A timing-/content-based oracle for token validity
 *      would let an enumerator harvest live tokens.
 *   2. Rate limit per source IP (60/min) — prevents enumeration even if the
 *      response shape eventually drifts.
 *   3. Token shape validation rejects anything that isn't exactly 32 chars
 *      of base64url before touching the DB.
 *   4. The DB update is idempotent (`.eq(unsub_token)` + opt-out flip), so a
 *      second click is a no-op rather than an error.
 *   5. DB errors do NOT leak as 5xx — they return the same SUCCESS_HTML with
 *      a 500 status so an enumerator can't tell live tokens from DB outages.
 */

const consumeRateLimitMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const eqMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: consumeRateLimitMock,
  rateLimitedResponse: (resetAt: string) =>
    new Response('Too Many Requests', {
      status: 429,
      headers: { 'Retry-After': '60', 'X-Reset-At': resetAt },
    }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      update: (...args: unknown[]) => {
        updateMock(...args);
        return { eq: eqMock };
      },
    }),
  }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  },
}));

const { GET, POST } = await import('@/app/api/email/unsubscribe/route');

const VALID_TOKEN = 'A'.repeat(32); // 32-char base64url-shaped string

beforeEach(() => {
  consumeRateLimitMock.mockReset();
  updateMock.mockReset();
  eqMock.mockReset();
  consumeRateLimitMock.mockResolvedValue({ ok: true, resetAt: new Date().toISOString() });
  eqMock.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('unsubscribe — token shape validation', () => {
  it('returns the SUCCESS page (not an error) when token is missing', async () => {
    const res = await GET(new Request('http://localhost/api/email/unsubscribe'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('unsubscribed');
    // Critically: no DB write was attempted.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns the SUCCESS page when token is too short', async () => {
    const res = await GET(
      new Request('http://localhost/api/email/unsubscribe?token=abc'),
    );
    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns the SUCCESS page when token contains invalid characters', async () => {
    // 32 chars including `=` which is not in the base64url alphabet.
    const bad = 'A'.repeat(30) + '==';
    const res = await GET(
      new Request(`http://localhost/api/email/unsubscribe?token=${bad}`),
    );
    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('unsubscribe — valid-token path', () => {
  it('flips digest_opt_out=true via service-role UPDATE keyed on the token', async () => {
    const res = await GET(
      new Request(`http://localhost/api/email/unsubscribe?token=${VALID_TOKEN}`),
    );
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.digest_opt_out).toBe(true);
    expect(typeof payload.updated_at).toBe('string');
    expect(eqMock).toHaveBeenCalledWith('digest_unsub_token', VALID_TOKEN);
  });

  it('returns a no-index meta tag so search engines do not crawl the page', async () => {
    const res = await GET(
      new Request(`http://localhost/api/email/unsubscribe?token=${VALID_TOKEN}`),
    );
    const html = await res.text();
    expect(html).toContain('noindex');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('returns Cache-Control: no-store (no CDN caching of confirmation pages)', async () => {
    const res = await GET(
      new Request(`http://localhost/api/email/unsubscribe?token=${VALID_TOKEN}`),
    );
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });
});

describe('unsubscribe — DB error masking', () => {
  it('returns SUCCESS_HTML body with 500 status when the UPDATE fails (no DB error leak)', async () => {
    eqMock.mockResolvedValue({ error: { message: 'connection refused' } });
    const res = await GET(
      new Request(`http://localhost/api/email/unsubscribe?token=${VALID_TOKEN}`),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('unsubscribed');
    // The DB error must NOT appear in the response body.
    expect(body).not.toContain('connection refused');
  });
});

describe('unsubscribe — rate limit', () => {
  it('uses x-forwarded-for first IP as the rate-limit key', async () => {
    await GET(
      new Request(`http://localhost/api/email/unsubscribe?token=${VALID_TOKEN}`, {
        headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.7' },
      }),
    );
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as { key: string; limit: number };
    expect(call.key).toBe('unsubscribe:203.0.113.5');
    expect(call.limit).toBe(60);
  });

  it('falls back to x-real-ip when x-forwarded-for is missing', async () => {
    await GET(
      new Request(`http://localhost/api/email/unsubscribe?token=${VALID_TOKEN}`, {
        headers: { 'x-real-ip': '198.51.100.10' },
      }),
    );
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as { key: string };
    expect(call.key).toBe('unsubscribe:198.51.100.10');
  });

  it('uses "unknown" when neither IP header is present', async () => {
    await GET(
      new Request(`http://localhost/api/email/unsubscribe?token=${VALID_TOKEN}`),
    );
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as { key: string };
    expect(call.key).toBe('unsubscribe:unknown');
  });

  it('returns 429 with Retry-After when the rate limit is exhausted', async () => {
    consumeRateLimitMock.mockResolvedValue({
      ok: false,
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });
    const res = await GET(
      new Request(`http://localhost/api/email/unsubscribe?token=${VALID_TOKEN}`),
    );
    expect(res.status).toBe(429);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('unsubscribe — POST (RFC 8058 one-click)', () => {
  it('POST behaves identically to GET (same handler)', async () => {
    const res = await POST(
      new Request(`http://localhost/api/email/unsubscribe?token=${VALID_TOKEN}`, {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.digest_opt_out).toBe(true);
  });
});
