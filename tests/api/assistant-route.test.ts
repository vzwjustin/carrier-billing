import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/assistant — the natural-language Q&A endpoint.
 *
 * The full Anthropic tool-use loop is out of scope to test directly
 * (would require stubbing the Anthropic SDK's streaming + tool_use
 * blocks). What we DO pin is the pre-stream boundary that decides
 * whether to call the model at all:
 *
 *   1. 400 on malformed JSON / wrong message shape / out-of-range
 *      role / content length / too many turns
 *   2. 401 when no session (no public surface — bills are private)
 *   3. 429 when per-user rate limit exhausted
 *   4. happy-path: opens an SSE stream (Content-Type: text/event-stream)
 *
 * Errors that occur AFTER the stream opens are SSE-encoded `error`
 * events, not HTTP status codes — the route header is already sent.
 * Those paths are covered by exercising the runAssistantLoop helper
 * elsewhere.
 */

const USER_ID = '33333333-3333-4333-8333-333333333333';

const {
  getUserMock,
  consumeRateLimitMock,
  anthropicCreateMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: consumeRateLimitMock,
  rateLimitedResponse: () => new Response('rate-limited', { status: 429 }),
}));

vi.mock('@/lib/assistant/model', () => ({
  ANTHROPIC_MODEL_ID: 'claude-opus-4-7',
  getAnthropicClient: () => ({
    messages: { create: anthropicCreateMock },
  }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  },
}));

import { POST } from '@/app/api/assistant/route';

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === '__raw_malformed__' ? '{not json' : JSON.stringify(body),
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  consumeRateLimitMock.mockReset();
  anthropicCreateMock.mockReset();
  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID } },
    error: null,
  });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    resetAt: new Date().toISOString(),
  });
  // Default: model returns a single end_turn with no tool use so the
  // stream completes quickly. Shape mirrors SDK 0.32.1's response.
  anthropicCreateMock.mockResolvedValue({
    stop_reason: 'end_turn',
    content: [],
  });
});

describe('POST /api/assistant — body validation', () => {
  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeReq('__raw_malformed__'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when messages array is missing', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 when messages array is empty', async () => {
    const res = await POST(makeReq({ messages: [] }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when messages array exceeds 20 turns', async () => {
    const turn = { role: 'user', content: 'hi' };
    const res = await POST(
      makeReq({ messages: Array(21).fill(turn) }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when role is not user|assistant', async () => {
    const res = await POST(
      makeReq({ messages: [{ role: 'system', content: 'hi' }] }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when content exceeds 4000 characters', async () => {
    const res = await POST(
      makeReq({
        messages: [{ role: 'user', content: 'x'.repeat(4001) }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when content is an empty string', async () => {
    const res = await POST(
      makeReq({ messages: [{ role: 'user', content: '' }] }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/assistant — auth + rate limit', () => {
  it('returns 401 when no session (no public surface)', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(
      makeReq({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(401);
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('uses a per-user rate-limit key (30 / 5min)', async () => {
    await POST(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as {
      key: string;
      limit: number;
      windowSeconds: number;
    };
    expect(call.key).toBe(`assistant:${USER_ID}`);
    expect(call.limit).toBe(30);
    expect(call.windowSeconds).toBe(300);
  });

  it('returns 429 (with no Anthropic call) when rate-limit exhausted', async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      resetAt: new Date().toISOString(),
    });
    const res = await POST(
      makeReq({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(429);
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/assistant — happy path', () => {
  it('opens an SSE stream (text/event-stream) when all preconditions pass', async () => {
    const res = await POST(
      makeReq({ messages: [{ role: 'user', content: 'hello' }] }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    // No buffering on the proxy edge.
    expect(res.headers.get('Cache-Control')?.toLowerCase()).toContain('no-cache');
  });
});
