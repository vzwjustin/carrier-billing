import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/settings/slack/test — fires a hello-world Block Kit
 * message to the user's saved Slack webhook URL.
 *
 * Coverage:
 *   - 401 on missing session
 *   - 429 when per-user rate limit is exhausted
 *   - 400 when no webhook is saved yet
 *   - 502 when Slack rejects the post (status returned)
 *   - 502 with generic message when network call fails (status: null)
 *   - 200 happy path
 *   - The user's webhook URL never appears in any response body
 */

const USER_ID = '33333333-3333-4333-8333-333333333333';
const SLACK_WEBHOOK = 'https://hooks.slack.com/services/T1/B1/secretpath';

const { getUserMock, consumeRateLimitMock, maybeSingleMock, postToSlackMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
  maybeSingleMock: vi.fn(),
  postToSlackMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: maybeSingleMock }),
      }),
    }),
  }),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: consumeRateLimitMock,
  rateLimitedResponse: () => new Response('Too Many Requests', { status: 429 }),
}));

vi.mock('@/inngest/functions/send-slack-notification', () => ({
  postToSlack: postToSlackMock,
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

import { POST } from '@/app/api/settings/slack/test/route';

function makeReq(): Request {
  return new Request('http://localhost/api/settings/slack/test', {
    method: 'POST',
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  consumeRateLimitMock.mockReset();
  maybeSingleMock.mockReset();
  postToSlackMock.mockReset();
  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID } },
    error: null,
  });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    resetAt: new Date().toISOString(),
  });
  maybeSingleMock.mockResolvedValue({
    data: { slack_webhook_url: SLACK_WEBHOOK },
    error: null,
  });
  postToSlackMock.mockResolvedValue({ ok: true, status: 200 });
});

describe('POST /api/settings/slack/test — auth + rate limit', () => {
  it('returns 401 when no session', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(postToSlackMock).not.toHaveBeenCalled();
  });

  it('uses a per-userId rate-limit key', async () => {
    await POST(makeReq());
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as {
      key: string;
      limit: number;
    };
    expect(call.key).toBe(`settings-slack-test:${USER_ID}`);
    expect(call.limit).toBe(6);
  });

  it('returns 429 when rate-limited', async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
    expect(postToSlackMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/slack/test — webhook not configured', () => {
  it('returns 400 when no webhook url is saved', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { slack_webhook_url: null },
      error: null,
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('Save a Slack webhook URL first.');
    expect(postToSlackMock).not.toHaveBeenCalled();
  });

  it('returns 500 with a generic message when the profile lookup errors', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection refused' },
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Could not load Slack settings.');
    expect(body.error).not.toContain('connection');
  });
});

describe('POST /api/settings/slack/test — Slack response handling', () => {
  it('returns 200 ok:true on a successful Slack response', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('passes a header + section block kit message to postToSlack', async () => {
    await POST(makeReq());
    const args = postToSlackMock.mock.calls[0];
    expect(args?.[0]).toBe(SLACK_WEBHOOK);
    const payload = args?.[1] as {
      text: string;
      blocks: Array<{ type: string }>;
    };
    expect(payload.text).toContain('test notification');
    expect(payload.blocks.map((b) => b.type)).toEqual(['header', 'section']);
  });

  it('returns 502 with a status-specific message when Slack rejects', async () => {
    postToSlackMock.mockResolvedValueOnce({ ok: false, status: 403 });
    const res = await POST(makeReq());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('403');
  });

  it('returns 502 with a generic message when the network call fails (status null)', async () => {
    postToSlackMock.mockResolvedValueOnce({ ok: false, status: null });
    const res = await POST(makeReq());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe('Could not reach Slack. Check the webhook URL.');
  });

  it('never echoes the user webhook URL in any response body', async () => {
    // Hit each branch and check none of them leak the URL.
    const cases: Array<() => Promise<Response>> = [
      async () => {
        postToSlackMock.mockResolvedValueOnce({ ok: false, status: 403 });
        return POST(makeReq());
      },
      async () => {
        postToSlackMock.mockResolvedValueOnce({ ok: false, status: null });
        return POST(makeReq());
      },
      async () => POST(makeReq()), // ok branch
    ];
    for (const run of cases) {
      const res = await run();
      const body = await res.text();
      expect(body).not.toContain(SLACK_WEBHOOK);
      expect(body).not.toContain('secretpath');
    }
  });
});
